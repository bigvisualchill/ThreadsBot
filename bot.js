import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';

puppeteer.use(StealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize OpenAI client (optional)
let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

// Global browser instance for headful mode
let globalBrowser = null;
let globalPage = null;

// Track liked posts to avoid duplicates
let likedPosts = new Set();
let discoveredPosts = new Set();

function getSessionFilePath(platform, sessionName) {
  const sessionsDir = path.join(__dirname, '.sessions');
  return { sessionsDir, sessionPath: path.join(sessionsDir, `${platform}-${sessionName}.json`) };
}

async function saveSession(page, platform, sessionName = 'default') {
  const { sessionsDir, sessionPath } = getSessionFilePath(platform, sessionName);
  await fs.mkdir(sessionsDir, { recursive: true });
  const cookies = await page.cookies();
  const storage = await page.evaluate(() => {
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key != null) ls[key] = localStorage.getItem(key);
    }
    const ss = {};
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key != null) ss[key] = sessionStorage.getItem(key);
    }
    return { localStorage: ls, sessionStorage: ss };
  });
  await fs.writeFile(sessionPath, JSON.stringify({ cookies, storage }, null, 2), 'utf8');
}

async function loadSession(page, platform, sessionName = 'default') {
  const { sessionPath } = getSessionFilePath(platform, sessionName);
  console.log(`Loading session from: ${sessionPath}`);
  try {
    const data = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
    console.log(`Session data loaded - cookies: ${data.cookies?.length || 0}, localStorage: ${Object.keys(data.storage?.localStorage || {}).length}, sessionStorage: ${Object.keys(data.storage?.sessionStorage || {}).length}`);
    
    let cookiesLoaded = false;
    if (Array.isArray(data.cookies) && data.cookies.length > 0) {
      await page.setCookie(...data.cookies);
      console.log(`Set ${data.cookies.length} cookies`);
      cookiesLoaded = true;
    } else {
      console.log('No cookies to set');
    }
    
    try {
      await page.evaluate(storage => {
        if (storage?.localStorage) {
          for (const [k, v] of Object.entries(storage.localStorage)) {
            localStorage.setItem(k, v);
          }
        }
        if (storage?.sessionStorage) {
          for (const [k, v] of Object.entries(storage.sessionStorage)) {
            sessionStorage.setItem(k, v);
          }
        }
      }, data.storage || {});
      console.log('LocalStorage and sessionStorage loaded successfully');
    } catch (storageError) {
      console.log(`Storage loading failed (${storageError.message}), but cookies were set - proceeding anyway`);
    }
    
    console.log('Session loaded successfully');
    return cookiesLoaded; // Return true if cookies were loaded, even if localStorage failed
  } catch (error) {
    console.log(`Failed to load session: ${error.message}`);
    return false;
  }
}

async function launchBrowser(headful) {
  console.log(`Launching browser with headful: ${headful}`);
  
  // For headful mode, try to reuse existing browser instance
  if (headful && globalBrowser && globalPage) {
    try {
      // Check if the existing browser is still connected
      if (globalBrowser.isConnected()) {
        console.log('Reusing existing headful browser instance');
        
        // Check if the page is still valid
        try {
          await globalPage.evaluate(() => true);
          console.log('Existing page is still valid, reusing it');
          return { browser: globalBrowser, page: globalPage };
        } catch (pageError) {
          console.log('Existing page is invalid, creating new page in existing browser');
          globalPage = await globalBrowser.newPage();
          await setupPage(globalPage, headful);
          return { browser: globalBrowser, page: globalPage };
        }
      } else {
        console.log('Existing browser is disconnected, creating new browser');
        globalBrowser = null;
        globalPage = null;
      }
    } catch (error) {
      console.log('Error checking existing browser, creating new one:', error.message);
      globalBrowser = null;
      globalPage = null;
    }
  }
  
  try {
    const browser = await puppeteer.launch({
      headless: headful ? false : true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
      ],
      defaultViewport: { width: 1280, height: 800 },
      ignoreDefaultArgs: ['--disable-extensions'],
    });
    
    const page = await browser.newPage();
    await setupPage(page, headful);
    
    // Store global references for headful mode
    if (headful) {
      globalBrowser = browser;
      globalPage = page;
      
      // Add disconnection handler to clean up global references
      browser.on('disconnected', () => {
        console.log('Browser disconnected, cleaning up global references');
        globalBrowser = null;
        globalPage = null;
      });
    }
    
    console.log(`Browser launched successfully with headful: ${headful}`);
    return { browser, page };
  } catch (error) {
    console.error('Browser launch error:', error);
    throw new Error(`Failed to launch browser: ${error.message}`);
  }
}

async function setupPage(page, headful) {
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  
  // Add error handlers for page
  page.on('error', (error) => {
    console.error('Page error:', error);
  });
  
  page.on('pageerror', (error) => {
    console.error('Page error:', error);
  });
  
  // Set longer timeouts for headful mode
  if (headful) {
    page.setDefaultTimeout(120000); // 2 minutes
    page.setDefaultNavigationTimeout(120000);
  }
}

async function clickFirstMatching(page, selectors) {
  for (const selector of selectors) {
    try {
      if (selector.includes(':contains(')) {
        // Handle text-based selectors
        const text = selector.match(/:contains\("([^"]+)"\)/)?.[1];
        if (text) {
          const baseSelector = selector.replace(/:contains\("([^"]+)"\)/, '');
          const elements = await page.$$(baseSelector);
          for (const element of elements) {
            const elementText = await element.evaluate(el => el.textContent || '');
            if (elementText.includes(text)) {
              // More reliable clicking with multiple methods
              await element.scrollIntoView({ block: 'center' });
              await new Promise(resolve => setTimeout(resolve, 500));
              
              try {
                // Get bounding box for mouse click
                const box = await element.boundingBox();
                if (box) {
                  const x = box.x + box.width / 2;
                  const y = box.y + box.height / 2;
                  console.log(`Attempting mouse click at coordinates: ${x}, ${y}`);
                  await page.mouse.click(x, y);
                  await new Promise(resolve => setTimeout(resolve, 1000));
                  console.log(`Mouse click completed on: ${selector}`);
                  return true;
                }
              } catch (mouseError) {
                console.log(`Mouse click failed: ${mouseError.message}, trying element click`);
                // Fallback to element click
                try {
                  await element.click({ delay: 50 });
                  await new Promise(resolve => setTimeout(resolve, 1000));
                  console.log(`Element click completed on: ${selector}`);
                  return true;
                } catch (clickError) {
                  console.log(`Element click failed: ${clickError.message}, trying evaluate click`);
                  // Final fallback to JavaScript click
                  await element.evaluate(el => el.click());
                  await new Promise(resolve => setTimeout(resolve, 1000));
                  console.log(`Evaluate click completed on: ${selector}`);
                  return true;
                }
              }
            }
          }
        }
      } else {
        // Handle regular CSS selectors
        const el = await page.$(selector);
        if (el) {
          console.log(`Found element with selector: ${selector}`);
          
          // Ensure element is visible and interactable
          await el.scrollIntoView({ block: 'center' });
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Check if element is visible
          const isVisible = await el.evaluate(element => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && 
                   style.visibility !== 'hidden' && 
                   style.display !== 'none' &&
                   style.opacity !== '0';
          });
          
          if (!isVisible) {
            console.log(`Element not visible: ${selector}`);
            continue;
          }
          
          // Try mouse click first (most human-like)
          try {
            const box = await el.boundingBox();
            if (box) {
              const x = box.x + box.width / 2;
              const y = box.y + box.height / 2;
              console.log(`Attempting mouse click at coordinates: ${x}, ${y} for selector: ${selector}`);
              await page.mouse.click(x, y);
              await new Promise(resolve => setTimeout(resolve, 1000));
              console.log(`Mouse click completed on: ${selector}`);
              return true;
            } else {
              console.log(`No bounding box available for: ${selector}, trying element click`);
            }
          } catch (mouseError) {
            console.log(`Mouse click failed: ${mouseError.message}, trying element click`);
          }
          
          // Fallback to Puppeteer's element click
          try {
            console.log(`Attempting element click on: ${selector}`);
            await el.click({ delay: 50 });
            await new Promise(resolve => setTimeout(resolve, 1000));
            console.log(`Element click completed on: ${selector}`);
            return true;
          } catch (clickError) {
            console.log(`Element click failed: ${clickError.message}, trying evaluate click`);
          }
          
          // Final fallback to JavaScript click
          try {
            console.log(`Attempting evaluate click on: ${selector}`);
            await el.evaluate(element => {
              element.click();
            });
            await new Promise(resolve => setTimeout(resolve, 1000));
            console.log(`Evaluate click completed on: ${selector}`);
            return true;
          } catch (evalError) {
            console.log(`All click methods failed for: ${selector}, error: ${evalError.message}`);
          }
        }
      }
    } catch (error) {
      console.log(`Selector failed: ${selector}`, error.message);
      continue;
    }
  }
  return false;
}

async function clickByText(page, texts) {
  for (const text of texts) {
    const xpath = `//*[self::button or self::div or self::span or self::a][contains(normalize-space(.), ${JSON.stringify(text)})]`;
    const elements = await page.$x(xpath);
    if (elements.length > 0) {
      await elements[0].click({ delay: 50 });
      return true;
    }
  }
  return false;
}

// AI Comment Generation
async function generateAIComment(postContent, context = '') {
  if (!openai) {
    throw new Error('OPENAI_API_KEY environment variable is required for AI comments');
  }

  const assistantId = 'asst_2aVBUHe0mfXS4JZmU5YYf5E4';
  
  try {
    // Create a thread
    const thread = await openai.beta.threads.create();
    
    // Add the message to the thread
    const message = await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: `Generate a natural, engaging comment for this social media post. The comment should be:
- 2-3 sentences maximum
- Friendly and supportive
- Relevant to the post content
- Not overly promotional
- Authentic and human-like

Post content: "${postContent}"
Additional context: "${context}"

Generate only the comment text, nothing else.`
    });

    // Run the assistant
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: assistantId,
    });

    // Wait for the run to complete
    let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    
    while (runStatus.status === 'in_progress' || runStatus.status === 'queued') {
      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    }

    if (runStatus.status === 'failed') {
      throw new Error('Assistant run failed');
    }

    // Get the response
    const messages = await openai.beta.threads.messages.list(thread.id);
    const lastMessage = messages.data[0]; // Get the most recent message (assistant's response)
    
    if (lastMessage.role === 'assistant' && lastMessage.content.length > 0) {
      return lastMessage.content[0].text.value.trim();
    } else {
      throw new Error('No response from assistant');
    }

  } catch (error) {
    console.error('OpenAI Assistant API error:', error.message);
    throw new Error(`Failed to generate AI comment: ${error.message}`);
  }
}

// Post Discovery Functions
async function discoverInstagramPosts(page, searchCriteria, maxPosts = 10) {
  const { hashtag, keywords } = searchCriteria;
  
  if (hashtag) {
    // Search by hashtag
    const url = `https://www.instagram.com/explore/tags/${encodeURIComponent(hashtag.replace('#', ''))}/`;
    await page.goto(url, { waitUntil: 'networkidle2' });
    
    // Scroll to load more posts
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Extract post URLs
    const posts = await page.$$eval('a[href^="/p/"]', (links, maxPosts) => {
      return Array.from(new Set(links.map(link => link.getAttribute('href'))))
        .slice(0, maxPosts)
        .map(href => `https://www.instagram.com${href}`);
    }, maxPosts);
    
    // Filter out already discovered posts
    const newPosts = posts.filter(postUrl => !discoveredPosts.has(postUrl));
    
    // Add new posts to discovered set
    newPosts.forEach(postUrl => discoveredPosts.add(postUrl));
    
    console.log(`🚀 DISCOVERY: Found ${posts.length} total posts, ${newPosts.length} new posts (${posts.length - newPosts.length} already discovered)`);
    
    return newPosts;
  } else if (keywords) {
    // Search by keywords (Instagram search)
    const searchUrl = `https://www.instagram.com/explore/tags/${encodeURIComponent(keywords.split(' ')[0])}/`;
    await page.goto(searchUrl, { waitUntil: 'networkidle2' });
    
    // Similar extraction logic
    const posts = await page.$$eval('a[href^="/p/"]', (links, maxPosts) => {
      return Array.from(new Set(links.map(link => link.getAttribute('href'))))
        .slice(0, maxPosts)
        .map(href => `https://www.instagram.com${href}`);
    }, maxPosts);
    
    // Filter out already discovered posts
    const newPosts = posts.filter(postUrl => !discoveredPosts.has(postUrl));
    
    // Add new posts to discovered set
    newPosts.forEach(postUrl => discoveredPosts.add(postUrl));
    
    console.log(`🚀 DISCOVERY: Found ${posts.length} total posts, ${newPosts.length} new posts (${posts.length - newPosts.length} already discovered)`);
    
    return newPosts;
  }
  
  return [];
}

async function discoverXPosts(page, searchCriteria, maxPosts = 10) {
  const { hashtag, keywords } = searchCriteria;
  
  if (hashtag) {
    const searchTerm = hashtag.startsWith('#') ? hashtag : `#${hashtag}`;
    const url = `https://x.com/search?q=${encodeURIComponent(searchTerm)}&src=typed_query&f=live`;
    await page.goto(url, { waitUntil: 'networkidle2' });
  } else if (keywords) {
    const url = `https://x.com/search?q=${encodeURIComponent(keywords)}&src=typed_query&f=live`;
    await page.goto(url, { waitUntil: 'networkidle2' });
  }
  
  // Scroll to load more tweets
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  // Extract tweet URLs
  const tweets = await page.$$eval('a[href*="/status/"]', (links, maxPosts) => {
    return Array.from(new Set(links.map(link => link.getAttribute('href'))))
      .filter(href => href.includes('/status/'))
      .slice(0, maxPosts)
      .map(href => href.startsWith('http') ? href : `https://x.com${href}`);
  }, maxPosts);
  
  return tweets;
}

async function getPostContent(page, postUrl, platform) {
  await page.goto(postUrl, { waitUntil: 'networkidle2' });
  
  if (platform === 'instagram') {
    // Extract Instagram post caption
    const caption = await page.evaluate(() => {
      const captionEl = document.querySelector('h1, [data-testid="post-caption"]');
      return captionEl ? captionEl.textContent.trim() : '';
    });
    return caption;
  } else if (platform === 'x') {
    // Extract X tweet text
    const tweetText = await page.evaluate(() => {
      const tweetEl = document.querySelector('[data-testid="tweetText"]');
      return tweetEl ? tweetEl.textContent.trim() : '';
    });
    return tweetText;
  }
  
  return '';
}

// Handle Instagram's one-tap login page
async function handleOneTapPage(page) {
  try {
    console.log('Handling one-tap login page...');
    await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for page to load
    
    // Try to find and click the dismiss button
    const dismissClicked = await page.evaluate(() => {
      // Look for various dismiss button selectors
      const selectors = [
        'button:contains("Not Now")',
        'button:contains("Not now")',
        'button:contains("Skip")',
        'button:contains("Don\'t Save")',
        'button:contains("Don\'t save")',
        'button:contains("Later")',
        'a:contains("Not Now")',
        'a:contains("Skip")',
        '[data-testid="save-login-info-dialog"] button',
        'div[role="dialog"] button'
      ];
      
      for (const selector of selectors) {
        const button = document.querySelector(selector);
        if (button) {
          console.log('Found dismiss button:', selector);
          button.click();
          return true;
        }
      }
      
      // Also try clicking any button that might be a dismiss action
      const buttons = document.querySelectorAll('button');
      for (const button of buttons) {
        const text = button.textContent?.toLowerCase() || '';
        if (text.includes('not now') || text.includes('don\'t save') || text.includes('skip') || text.includes('later')) {
          console.log('Found dismiss button with text:', text);
          button.click();
          return true;
        }
      }
      
      return false;
    });
    
    if (dismissClicked) {
      console.log('Successfully dismissed one-tap page');
      await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for navigation
      
      // Wait for navigation to complete
      try {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
        console.log('Navigation completed after dismissing one-tap page');
      } catch (navError) {
        console.log('Navigation after one-tap handling:', navError.message);
      }
    } else {
      console.log('Could not find dismiss button on one-tap page');
    }
  } catch (error) {
    console.log('Error handling one-tap page:', error.message);
  }
}

// Instagram flows
async function ensureInstagramLoggedIn(page, { username, password }) {
  try {
    console.log('Checking Instagram login status...');
    
    // First, go to Instagram home to check current status
    const currentUrl = page.url();
    if (!currentUrl.includes('instagram.com')) {
      console.log('Navigating to Instagram...');
      await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2', timeout: 30000 });
    }
    
    // Wait for page to load
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Check current URL after navigation
    const finalUrl = page.url();
    console.log('Final URL after navigation:', finalUrl);
    
    // If we're on the one-tap page, handle it immediately
    if (finalUrl.includes('/accounts/onetap/')) {
      console.log('Found one-tap page - handling save login info prompt');
      await handleOneTapPage(page);
      return true;
    }
    
    // Check if we're already logged in to main Instagram
    const loginCheckResult = await page.evaluate(() => {
      const debugLog = [];
      debugLog.push('Checking login status on URL: ' + window.location.href);
      
      // First check: Are we on a login page?
      if (window.location.href.includes('/accounts/login/')) {
        debugLog.push('On login page - NOT logged in');
        return { isLoggedIn: false, debugLog };
      }
      
      // Second check: Look for specific login form elements (indicates NOT logged in)
      const usernameInput = document.querySelector('input[name="username"]');
      const passwordInput = document.querySelector('input[name="password"]');
      const usernameTypeInput = document.querySelector('input[type="text"][placeholder*="username"]');
      const phoneEmailInput = document.querySelector('input[placeholder*="Phone number, username, or email"]');
      
      const loginFormElements = [];
      if (usernameInput) loginFormElements.push('input[name="username"]');
      if (passwordInput) loginFormElements.push('input[name="password"]');
      if (usernameTypeInput) loginFormElements.push('input[type="text"][placeholder*="username"]');
      if (phoneEmailInput) loginFormElements.push('input[placeholder*="Phone number, username, or email"]');
      
      // Only consider it a login form if we have username AND password inputs together
      const hasLoginForm = (usernameInput && passwordInput) || usernameTypeInput || phoneEmailInput;
      
      if (hasLoginForm) {
        debugLog.push('Found login form elements: ' + loginFormElements.join(', ') + ' - NOT logged in');
        return { isLoggedIn: false, debugLog };
      } else if (loginFormElements.length > 0) {
        debugLog.push('Found some form elements but not a complete login form: ' + loginFormElements.join(', '));
      }
      
      // Third check: Look for logged-in indicators
      const loginIndicators = [
        // Navigation elements
        'nav a[href*="/accounts/edit/"]',
        'a[href*="/accounts/edit/"]', 
        '[data-testid="user-avatar"]',
        'img[alt*="profile picture"]',
        'a[href*="/accounts/activity/"]',
        '[data-testid="AppTabBar_Profile_Link"]',
        'a[href*="/direct/"]',
        // SVG icons in navigation
        'svg[aria-label="Home"]',
        'svg[aria-label="Search"]',
        'svg[aria-label="New post"]',
        'svg[aria-label="Activity Feed"]',
        'svg[aria-label="Profile"]',
        // General logged-in elements
        '[role="main"]',
        'nav[role="navigation"]',
        // Story elements (only visible when logged in)
        '[data-testid="story-viewer"]',
        // Feed elements
        'article',
        '[data-testid="post"]'
      ];
      
      let foundElements = [];
      for (const selector of loginIndicators) {
        const element = document.querySelector(selector);
        if (element) {
          foundElements.push(selector);
        }
      }
      
      debugLog.push('Found login indicators: ' + foundElements.join(', '));
      debugLog.push('Page title: ' + document.title);
      
      // Fourth check: Check page title (Instagram login page has specific title)
      if (document.title.includes('Login') || document.title.includes('Sign up')) {
        debugLog.push('Login/signup page title detected - NOT logged in');
        return { isLoggedIn: false, debugLog };
      }
      
      // If we found any strong login indicators and no login form, we're logged in
      const strongIndicators = foundElements.filter(el => 
        el.includes('nav') || 
        el.includes('profile') || 
        el.includes('Home') || 
        el.includes('Search') ||
        el.includes('accounts/edit') ||
        el.includes('direct')
      );
      
      debugLog.push('Strong login indicators: ' + strongIndicators.join(', '));
      
      // More lenient: just need 1 strong indicator OR several weak ones
      const isLoggedIn = strongIndicators.length >= 1 || foundElements.length >= 3;
      debugLog.push('Login detection result: ' + isLoggedIn);
      
      return { isLoggedIn, debugLog };
    });
    
    // Log all the debug information from the browser
    console.log('=== Instagram Login Detection Debug ===');
    loginCheckResult.debugLog.forEach(log => console.log(log));
    console.log('=======================================');
    
    if (loginCheckResult.isLoggedIn) {
      console.log('Already logged in to Instagram');
      return true;
    }

    if (!username || !password) {
      throw new Error('Instagram session missing and no credentials provided. Provide username/password or login headfully and save a session.');
    }

    console.log('Logging in to Instagram...');
    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Wait for the page to load and check if we're already logged in
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Check again if we're logged in (sometimes redirect happens)
    const stillLoggedIn = await page.evaluate(() => {
      const currentUrl = window.location.href;
      console.log('Current URL after login redirect:', currentUrl);
      
      // If we're on one-tap page, that means we're logged in
      if (currentUrl.includes('/accounts/onetap/')) {
        console.log('On one-tap page - logged in');
        return true;
      }
      
      // More specific selectors that only appear when logged in
      const loginIndicators = [
        'nav a[href*="/accounts/edit/"]',
        'a[href*="/accounts/edit/"]', 
        '[data-testid="user-avatar"]',
        'img[alt*="profile picture"]',
        'a[href*="/accounts/activity/"]',
        '[data-testid="AppTabBar_Profile_Link"]',
        'a[href*="/direct/"]',
        // Look for specific logged-in elements
        'svg[aria-label="Home"]',
        'svg[aria-label="Search"]',
        'svg[aria-label="New post"]',
        'svg[aria-label="Activity Feed"]'
      ];
      
      let foundElements = [];
      for (const selector of loginIndicators) {
        const element = document.querySelector(selector);
        if (element) {
          foundElements.push(selector);
        }
      }
      
      console.log('Found login indicators after redirect:', foundElements);
      
      // Also check if we see login form (indicates NOT logged in)
      const loginForm = document.querySelector('input[name="username"]') || 
                       document.querySelector('input[type="text"][placeholder*="username"]') ||
                       document.querySelector('form[method="post"]');
      
      if (loginForm) {
        console.log('Found login form after redirect - NOT logged in');
        return false;
      }
      
      // Need at least 2 login indicators to be confident
      return foundElements.length >= 2;
    });
    
    if (stillLoggedIn) {
      console.log('Already logged in to Instagram (after navigation)');
      return true;
    }
    
    console.log('Not logged in, proceeding with login form...');
    
    // Try to find the login form with multiple selectors
    const usernameSelector = await page.evaluate(() => {
      const selectors = [
        'input[name="username"]',
        'input[aria-label="Phone number, username, or email"]',
        'input[placeholder*="username"]',
        'input[placeholder*="email"]',
        'input[type="text"]'
      ];
      
      for (const selector of selectors) {
        if (document.querySelector(selector)) {
          return selector;
        }
      }
      return null;
    });
    
    if (!usernameSelector) {
      throw new Error('Could not find username input field - Instagram login page may have changed');
    }
    
    console.log(`Found username selector: ${usernameSelector}`);
    await page.waitForSelector(usernameSelector, { timeout: 30000 });
    await page.type(usernameSelector, username, { delay: 20 });
    
    // Find password field
    const passwordSelector = await page.evaluate(() => {
      const selectors = [
        'input[name="password"]',
        'input[aria-label="Password"]',
        'input[type="password"]'
      ];
      
      for (const selector of selectors) {
        if (document.querySelector(selector)) {
          return selector;
        }
      }
      return null;
    });
    
    if (!passwordSelector) {
      throw new Error('Could not find password input field');
    }
    
    console.log(`Found password selector: ${passwordSelector}`);
    await page.type(passwordSelector, password, { delay: 20 });
    
    // Find and click submit button
    const submitClicked = await clickFirstMatching(page, [
      'button[type="submit"]',
      'button:contains("Log In")',
      'button:contains("Log in")',
      'input[type="submit"]'
    ]);
    
    if (!submitClicked) {
      throw new Error('Could not find login submit button');
    }
    
    console.log('Login form submitted, waiting for navigation...');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
    
    // Check where we ended up after login
    const postLoginUrl = page.url();
    console.log('Post-login URL:', postLoginUrl);
    
    // If we're on the one-tap page, handle it
    if (postLoginUrl.includes('/accounts/onetap/')) {
      console.log('Redirected to one-tap page after login - handling it');
      await handleOneTapPage(page);
      return true;
    }
    
    // Handle "Save login info" popup that appears after login
    try {
      console.log('Checking for save login info popup...');
      await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for popup to appear
      
      const popupHandled = await page.evaluate(() => {
        // Look for and handle various popup types
        const selectors = [
          'button:contains("Not Now")',
          'button:contains("Not now")',
          'button:contains("Save Info")',
          'button:contains("Save info")',
          'button:contains("Don\'t Save")',
          'button:contains("Don\'t save")',
          '[data-testid="save-login-info-dialog"] button',
          'div[role="dialog"] button'
        ];
        
        for (const selector of selectors) {
          const button = document.querySelector(selector);
          if (button) {
            button.click();
            return true;
          }
        }
        
        // Also try clicking any button that might be a popup dismiss
        const buttons = document.querySelectorAll('button');
        for (const button of buttons) {
          const text = button.textContent?.toLowerCase() || '';
          if (text.includes('not now') || text.includes('don\'t save') || text.includes('later')) {
            button.click();
            return true;
          }
        }
        
        return false;
      });
      
      if (popupHandled) {
        console.log('Handled save login info popup');
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for popup to disappear
      }
    } catch (popupError) {
      console.log('No popup found or popup handling failed:', popupError.message);
    }
    
    // Verify login was successful
    const loginSuccessful = await page.evaluate(() => {
      const currentUrl = window.location.href;
      console.log('Final verification URL:', currentUrl);
      
      // If we're on one-tap page, that means we're logged in
      if (currentUrl.includes('/accounts/onetap/')) {
        console.log('On one-tap page - login successful');
        return true;
      }
      
      // Look for specific logged-in elements
      const loginIndicators = [
        'nav a[href*="/accounts/edit/"]',
        'a[href*="/accounts/edit/"]', 
        '[data-testid="user-avatar"]',
        'img[alt*="profile picture"]',
        'a[href*="/accounts/activity/"]',
        '[data-testid="AppTabBar_Profile_Link"]',
        'a[href*="/direct/"]',
        'svg[aria-label="Home"]',
        'svg[aria-label="Search"]',
        'svg[aria-label="New post"]'
      ];
      
      let foundElements = [];
      for (const selector of loginIndicators) {
        const element = document.querySelector(selector);
        if (element) {
          foundElements.push(selector);
        }
      }
      
      console.log('Final verification - found login indicators:', foundElements);
      
      // Check if we still see login form (indicates NOT logged in)
      const loginForm = document.querySelector('input[name="username"]') || 
                       document.querySelector('input[type="text"][placeholder*="username"]');
      
      if (loginForm) {
        console.log('Still see login form - login failed');
        return false;
      }
      
      // Need at least 1 strong login indicator
      return foundElements.length >= 1;
    });
    
    if (!loginSuccessful) {
      throw new Error('Login failed - please check your credentials');
    }
    
    console.log('Instagram login successful');
    return true;
  } catch (error) {
    console.error('Instagram login error:', error);
    throw new Error(`Instagram login error: ${error.message}`);
  }
}

async function instagramLike(page, postUrl) {
  console.log(`🚀 NEW CODE: instagramLike function called with URL: ${postUrl}`);
  
  // Check if this post has already been liked
  if (likedPosts.has(postUrl)) {
    console.log(`🚀 SKIPPING: Post ${postUrl} has already been liked`);
    return true; // Return true to indicate "success" (already liked)
  }
  
  await page.goto(postUrl, { waitUntil: 'networkidle2' });
  await new Promise(resolve => setTimeout(resolve, 2000)); // Longer wait for page to load
  
  console.log(`🚀 NEW CODE: Page loaded, attempting to like post: ${postUrl}`);
  
  // Simple approach: just try to click the first like button we can find in the main content area
  console.log('=== STARTING SIMPLE LIKE BUTTON DETECTION ===');
  
  const result = await page.evaluate(() => {
    // Find all like buttons on the page
    const likeButtons = document.querySelectorAll('svg[aria-label="Like"]');
    const debugInfo = [];
    
    // Try to find the main post area first
    const mainPostSelectors = [
      'article',
      '[role="main"]',
      'main',
      '.post',
      '[data-testid="post"]'
    ];
    
    let mainPostArea = null;
    for (const selector of mainPostSelectors) {
      const element = document.querySelector(selector);
      if (element) {
        mainPostArea = element;
        break;
      }
    }
    
    for (let i = 0; i < likeButtons.length; i++) {
      const likeButton = likeButtons[i];
      const rect = likeButton.getBoundingClientRect();
      
      // Check if this like button is within the main post area
      const isInMainPost = mainPostArea ? mainPostArea.contains(likeButton) : false;
      
      debugInfo.push({
        index: i,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        inMainContent: rect.x < 800,
        inMainPost: isInMainPost
      });
      
      // Click like buttons, prioritizing the first one (usually the main post)
      if (rect.width > 0 && rect.height > 0) {
        // Skip comment likes by checking if this is likely a comment like button
        // Comment like buttons are usually smaller and positioned differently
        const isLikelyCommentLike = rect.width < 20 || rect.height < 20 || 
                                   (likeButton.closest('ul') && likeButton.closest('li'));
        
        if (isLikelyCommentLike) {
          continue; // Skip comment like buttons
        }
        
        // Find the clickable parent element
        const clickableParent = likeButton.closest('div[role="button"]') || 
                               likeButton.closest('button') || 
                               likeButton.parentElement;
        
        if (clickableParent) {
          clickableParent.click();
        } else {
          likeButton.click();
        }
        
        return { clicked: true, buttonIndex: i, debugInfo, inMainPost: isInMainPost, isCommentLike: isLikelyCommentLike };
      }
    }
    
    return { clicked: false, debugInfo };
  });
  
  console.log(`Found ${result.debugInfo.length} like buttons:`, result.debugInfo);
  
  if (result.clicked) {
    console.log(`Successfully clicked like button ${result.buttonIndex}`);
    clicked = true;
    
    // Mark this post as liked to avoid duplicates
    likedPosts.add(postUrl);
    console.log(`🚀 MARKED AS LIKED: ${postUrl} (total liked: ${likedPosts.size})`);
  } else {
    console.log('No suitable like buttons found in main content area');
    clicked = false;
  }
  
  console.log(`=== SIMPLE LIKE DETECTION COMPLETED, RESULT: ${clicked} ===`);
  
  if (result.clicked) {
    console.log(`Successfully clicked like button on ${postUrl}`);
    
    // Wait a moment and check if the like state changed
    await new Promise(resolve => setTimeout(resolve, 1000));
    const likeStateAfter = await page.evaluate(() => {
      const likeButton = document.querySelector('article svg[aria-label="Unlike"]') || 
                        document.querySelector('svg[aria-label="Unlike"]');
      const unlikeButton = document.querySelector('article svg[aria-label="Like"]') || 
                          document.querySelector('svg[aria-label="Like"]');
      return {
        hasUnlikeButton: !!likeButton, // If we see "Unlike", the post is liked
        hasLikeButton: !!unlikeButton, // If we see "Like", the post is not liked
      };
    });
    console.log(`Like state after click:`, likeStateAfter);
  } else {
    // Get debug info to include in error message
    const debugInfo = await page.evaluate(() => {
      const allLikes = document.querySelectorAll('svg[aria-label="Like"]');
      const likeButtonDetails = [];
      
      for (let i = 0; i < allLikes.length; i++) {
        const likeButton = allLikes[i];
        const rect = likeButton.getBoundingClientRect();
        likeButtonDetails.push({
          index: i,
          position: `${Math.round(rect.x)},${Math.round(rect.y)}`,
          size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
          inMainContent: rect.x < 800
        });
      }
      
      return {
        totalLikes: allLikes.length,
        likeButtonDetails
      };
    });
    
    console.log(`Could not find any like button on ${postUrl}`);
    console.log('Debug info:', JSON.stringify(debugInfo, null, 2));
    throw new Error(`Could not find Like button. Found ${debugInfo.totalLikes} total like buttons. Details: ${JSON.stringify(debugInfo.likeButtonDetails)}`);
  }
}

async function instagramComment(page, postUrl, comment) {
  await page.goto(postUrl, { waitUntil: 'networkidle2' });
  await new Promise(resolve => setTimeout(resolve, 1000));
  await clickFirstMatching(page, [
    'svg[aria-label="Comment"]',
    'span[aria-label="Comment"]',
    'button svg[aria-label="Comment"]',
  ]);
  await page.waitForSelector('textarea', { timeout: 20000 });
  await page.type('textarea', comment, { delay: 10 });
  const posted = await clickFirstMatching(page, [
    'button[type="submit"]',
  ]) || await clickByText(page, ['Post']);
  if (!posted) {
    await page.keyboard.press('Enter');
  }
}

// X (Twitter) flows
async function ensureXLoggedIn(page, { username, password }) {
  try {
    // Check if we're already logged in
    const currentUrl = page.url();
    if (!currentUrl.includes('x.com') && !currentUrl.includes('twitter.com')) {
      await page.goto('https://x.com/home', { waitUntil: 'networkidle2' });
    }
    
    const isLoggedIn = await page.evaluate(() => !!document.querySelector('[data-testid="AppTabBar_Home_Link"]'));
    if (isLoggedIn) return true;

    if (!username || !password) {
      throw new Error('X session missing and no credentials provided. Provide username/password or login headfully and save a session.');
    }

    await page.goto('https://x.com/login', { waitUntil: 'networkidle2' });
    await page.waitForSelector('input[name="text"]', { timeout: 30000 });
    await page.type('input[name="text"]', username, { delay: 20 });
    await clickFirstMatching(page, ['div[role="button"][data-testid="LoginForm_Login_Button"]']) || await clickByText(page, ['Next']);
    // Some accounts require @handle confirmation step
    const passwordSelector = 'input[name="password"]';
    await page.waitForSelector(passwordSelector, { timeout: 30000 });
    await page.type(passwordSelector, password, { delay: 20 });
    await clickFirstMatching(page, ['div[role="button"][data-testid="LoginForm_Login_Button"]']) || await clickByText(page, ['Log in', 'Log In']);
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
    
    // Verify login was successful
    const loginSuccessful = await page.evaluate(() => !!document.querySelector('[data-testid="AppTabBar_Home_Link"]'));
    if (!loginSuccessful) {
      throw new Error('Login failed - please check your credentials');
    }
    
    return true;
  } catch (error) {
    throw new Error(`X login error: ${error.message}`);
  }
}

async function xLike(page, tweetUrl) {
  await page.goto(tweetUrl, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-testid="like"]', { timeout: 20000 });
  await clickFirstMatching(page, ['[data-testid="like"]']);
}

async function xComment(page, tweetUrl, comment) {
  await page.goto(tweetUrl, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-testid="reply"]', { timeout: 20000 });
  await clickFirstMatching(page, ['[data-testid="reply"]']);
  await page.waitForSelector('[data-testid="tweetTextarea_0"] div[contenteditable="true"]', { timeout: 20000 });
  await page.type('[data-testid="tweetTextarea_0"] div[contenteditable="true"]', comment, { delay: 10 });
  await clickFirstMatching(page, ['div[data-testid="tweetButtonInline"]', 'div[data-testid="tweetButton"]']);
}

// Session management functions
async function checkSessionStatus(page, platform, sessionName = 'default') {
  try {
    await loadSession(page, platform, sessionName);
    
    if (platform === 'instagram') {
      await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2' });
      const isLoggedIn = await page.evaluate(() => !!document.querySelector('nav a[href*="/accounts/edit/"]'));
      return { loggedIn: isLoggedIn };
    } else if (platform === 'x') {
      await page.goto('https://x.com/home', { waitUntil: 'networkidle2' });
      const isLoggedIn = await page.evaluate(() => !!document.querySelector('[data-testid="AppTabBar_Home_Link"]'));
      return { loggedIn: isLoggedIn };
    }
    
    return { loggedIn: false };
  } catch (error) {
    return { loggedIn: false, error: error.message };
  }
}

async function logout(page, platform, sessionName = 'default') {
  console.log(`Starting logout for ${platform} session: ${sessionName}`);
  
  try {
    // Delete session file first (most important)
    const { sessionPath } = getSessionFilePath(platform, sessionName);
    try {
      await fs.unlink(sessionPath);
      console.log(`Deleted session file: ${sessionPath}`);
    } catch (e) {
      console.log(`Session file not found or already deleted: ${sessionPath}`);
    }
    
    // Clear browser storage immediately
    await page.evaluate(() => {
      // Clear all cookies
      document.cookie.split(";").forEach(function(c) { 
        document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/"); 
      });
      // Clear localStorage and sessionStorage
      localStorage.clear();
      sessionStorage.clear();
    });
    
    console.log(`Logout completed successfully for ${platform}`);
    return { success: true, message: `Successfully logged out from ${platform}` };
    
  } catch (error) {
    console.error('Logout error:', error);
    
    // Even if there's an error, try to delete the session file
    try {
      const { sessionPath } = getSessionFilePath(platform, sessionName);
      await fs.unlink(sessionPath);
      console.log(`Deleted session file after error: ${sessionPath}`);
    } catch (e) {
      console.log(`Could not delete session file: ${e.message}`);
    }
    
    return { success: false, error: error.message || 'Unknown logout error' };
  }
}

export async function runAction(options) {
  const {
    platform,
    action,
    url,
    comment,
    username,
    password,
    headful = false,
    dryRun = false,
    sessionName = 'default',
    searchCriteria,
    maxPosts = 5,
    useAI = false,
    aiContext = '',
  } = options;

  console.log(`runAction called with action: ${action}, platform: ${platform}, sessionName: ${sessionName}`);
  
  // Clear liked posts tracking when starting a new like action
  if (action === 'like') {
    likedPosts.clear();
    discoveredPosts.clear();
    console.log(`🚀 CLEARED TRACKING: Starting fresh like session (cleared ${likedPosts.size} liked posts, ${discoveredPosts.size} discovered posts)`);
  }

  let browser;
  let page;

  try {
    // Validation
    if (!platform || !['instagram', 'x'].includes(platform)) {
      throw new Error('Invalid or missing platform');
    }
    if (!action || !['login', 'like', 'comment', 'follow', 'discover', 'auto-comment', 'check-session', 'logout'].includes(action)) {
      throw new Error('Invalid or missing action');
    }
    if (['like', 'comment', 'follow'].includes(action) && !url && !searchCriteria) {
      throw new Error('url is required for like/comment/follow (or use search criteria for bulk operations)');
    }
    if (action === 'comment' && !comment && !useAI) {
      throw new Error('comment is required for comment action (or enable AI)');
    }
    if (['discover', 'auto-comment'].includes(action) && !searchCriteria) {
      throw new Error('searchCriteria is required for discover/auto-comment actions');
    }

    // Launch browser
    const browserResult = await launchBrowser(headful);
    browser = browserResult.browser;
    page = browserResult.page;
    console.log(`Browser and page ready. Headful: ${headful}, Action: ${action}`);

    // Handle logout action
    if (action === 'logout') {
      try {
        const result = await logout(page, platform, sessionName);
        if (result.success) {
          return { ok: true, message: result.message || 'Logged out successfully' };
        } else {
          return { ok: false, message: `Logout failed: ${result.error || 'Unknown error'}` };
        }
      } catch (error) {
        console.error('Logout error:', error);
        return { ok: false, message: `Logout failed: ${error.message || 'Unknown error'}` };
      }
    }

    // Handle check-session action
    if (action === 'check-session') {
      page = browserResult.page;
      const result = await checkSessionStatus(page, platform, sessionName);
      return { ok: true, ...result };
    }

    // Handle dry run
    if (dryRun) {
      return { ok: true, dryRun: true, executed: { platform, action, url, headful, sessionName, searchCriteria, useAI } };
    }

    // Load session and check login status
    console.log(`Attempting to load session: ${sessionName} for platform: ${platform}`);
    const sessionLoaded = await loadSession(page, platform, sessionName);
    console.log(`Session loading result: ${sessionLoaded}`);
    
    const homeUrl = platform === 'instagram' ? 'https://www.instagram.com/' : 'https://x.com/home';
    console.log(`Navigating to: ${homeUrl}`);
    await page.goto(homeUrl, { waitUntil: 'networkidle2' });
    
    // Debug: Check what cookies are actually set after loading
    const currentCookies = await page.cookies();
    console.log(`Cookies currently set: ${currentCookies.length}`);
    if (currentCookies.length > 0) {
      console.log('Sample cookies:', currentCookies.slice(0, 3).map(c => c.name).join(', '));
    }

    if (platform === 'instagram') {
      if (action === 'login') {
        try {
          console.log('Starting Instagram login process...');
          await ensureInstagramLoggedIn(page, { username, password });
          console.log('Instagram login successful, saving session...');
          await saveSession(page, platform, sessionName);
          console.log('Session saved successfully');
          return { ok: true, message: 'Instagram login successful and session saved.' };
        } catch (error) {
          console.error('Instagram login error details:', {
            message: error.message,
            name: error.name,
            stack: error.stack
          });
          return { ok: false, message: `Instagram login failed: ${error.message}` };
        }
      }

      console.log('Ensuring Instagram is logged in...');
      await ensureInstagramLoggedIn(page, { username, password });
      console.log('Instagram login verified');
      
      if (action === 'discover') {
        console.log(`Discovering Instagram posts with criteria: ${JSON.stringify(searchCriteria)}`);
        // Parse search criteria properly
        const parsedCriteria = typeof searchCriteria === 'string' 
          ? (searchCriteria.startsWith('#') 
              ? { hashtag: searchCriteria } 
              : { keywords: searchCriteria })
          : searchCriteria;
        const posts = await discoverInstagramPosts(page, parsedCriteria, maxPosts);
        console.log(`Discovered ${posts.length} Instagram posts`);
        return { ok: true, message: `Found ${posts.length} Instagram posts`, posts };
      }
      
      if (action === 'auto-comment') {
        console.log(`Auto-commenting on Instagram posts with criteria: ${JSON.stringify(searchCriteria)}`);
        // Parse search criteria properly
        const parsedCriteria = typeof searchCriteria === 'string' 
          ? (searchCriteria.startsWith('#') 
              ? { hashtag: searchCriteria } 
              : { keywords: searchCriteria })
          : searchCriteria;
        const posts = await discoverInstagramPosts(page, parsedCriteria, maxPosts);
        console.log(`Found ${posts.length} posts for auto-commenting`);
        const results = [];
        
        for (const postUrl of posts) {
          try {
            console.log(`Processing post for auto-comment: ${postUrl}`);
            const postContent = await getPostContent(page, postUrl, platform);
            const aiComment = useAI ? await generateAIComment(postContent, aiContext) : comment;
            console.log(`Generated auto-comment: "${aiComment}"`);
            await instagramComment(page, postUrl, aiComment);
            console.log(`Successfully auto-commented on post: ${postUrl}`);
            results.push({ url: postUrl, success: true, comment: aiComment });
            await new Promise(resolve => setTimeout(resolve, 3000)); // Delay between comments
          } catch (error) {
            console.log(`Failed to auto-comment on post ${postUrl}: ${error.message}`);
            results.push({ url: postUrl, success: false, error: error.message });
          }
        }
        
        return { ok: true, message: `Auto-commented on ${results.filter(r => r.success).length} posts`, results };
      }

      if (action === 'like') {
        if (searchCriteria) {
          // Bulk like from search results
          console.log(`Discovering Instagram posts for bulk like with criteria: ${JSON.stringify(searchCriteria)}`);
          // Parse search criteria properly
          const parsedCriteria = typeof searchCriteria === 'string' 
            ? (searchCriteria.startsWith('#') 
                ? { hashtag: searchCriteria } 
                : { keywords: searchCriteria })
            : searchCriteria;
          const posts = await discoverInstagramPosts(page, parsedCriteria, maxPosts);
          console.log(`Found ${posts.length} posts to like`);
          const results = [];
          
          for (const postUrl of posts) {
            try {
              console.log(`Attempting to like post: ${postUrl}`);
              await instagramLike(page, postUrl);
              console.log(`Successfully liked post: ${postUrl}`);
              results.push({ url: postUrl, success: true });
              await new Promise(resolve => setTimeout(resolve, 5000)); // Longer delay between likes to avoid detection
            } catch (error) {
              console.log(`Failed to like post ${postUrl}: ${error.message}`);
              results.push({ url: postUrl, success: false, error: error.message });
            }
          }
          
          return { ok: true, message: `Liked ${results.filter(r => r.success).length} Instagram posts`, results };
        } else {
          // Single post like
          console.log(`Attempting to like single Instagram post: ${url}`);
          await instagramLike(page, url);
          console.log(`Successfully liked Instagram post: ${url}`);
        }
      }
      if (action === 'comment') {
        if (searchCriteria) {
          // Bulk comment from search results
          console.log(`Discovering Instagram posts for bulk comment with criteria: ${JSON.stringify(searchCriteria)}`);
          // Parse search criteria properly
          const parsedCriteria = typeof searchCriteria === 'string' 
            ? (searchCriteria.startsWith('#') 
                ? { hashtag: searchCriteria } 
                : { keywords: searchCriteria })
            : searchCriteria;
          const posts = await discoverInstagramPosts(page, parsedCriteria, maxPosts);
          console.log(`Found ${posts.length} posts to comment on`);
          const results = [];
          
          for (const postUrl of posts) {
            try {
              console.log(`Attempting to comment on post: ${postUrl}`);
              const postContent = await getPostContent(page, postUrl, platform);
              const finalComment = useAI ? await generateAIComment(postContent, aiContext) : comment;
              console.log(`Generated comment: "${finalComment}"`);
              await instagramComment(page, postUrl, finalComment);
              console.log(`Successfully commented on post: ${postUrl}`);
              results.push({ url: postUrl, success: true, comment: finalComment });
              await new Promise(resolve => setTimeout(resolve, 3000)); // Delay between comments
            } catch (error) {
              console.log(`Failed to comment on post ${postUrl}: ${error.message}`);
              results.push({ url: postUrl, success: false, error: error.message });
            }
          }
          
          return { ok: true, message: `Commented on ${results.filter(r => r.success).length} Instagram posts`, results };
        } else {
          // Single post comment
          console.log(`Attempting to comment on single Instagram post: ${url}`);
          const finalComment = useAI ? await generateAIComment('', aiContext) : comment;
          console.log(`Generated comment: "${finalComment}"`);
          await instagramComment(page, url, finalComment);
          console.log(`Successfully commented on Instagram post: ${url}`);
        }
      }
      if (action === 'follow') {
        await page.goto(url, { waitUntil: 'networkidle2' });
        const followed = await clickByText(page, ['Follow']);
        if (!followed) throw new Error('Could not find Follow button on Instagram profile.');
      }
    }

    if (platform === 'x') {
      if (action === 'login') {
        try {
          await ensureXLoggedIn(page, { username, password });
          await saveSession(page, platform, sessionName);
          return { ok: true, message: 'X login successful and session saved.' };
        } catch (error) {
          return { ok: false, message: `X login failed: ${error.message}` };
        }
      }

      await ensureXLoggedIn(page, { username, password });
      
      if (action === 'discover') {
        const posts = await discoverXPosts(page, searchCriteria, maxPosts);
        return { ok: true, message: `Found ${posts.length} X posts`, posts };
      }
      
      if (action === 'auto-comment') {
        const posts = await discoverXPosts(page, searchCriteria, maxPosts);
        const results = [];
        
        for (const postUrl of posts) {
          try {
            const postContent = await getPostContent(page, postUrl, platform);
            const aiComment = useAI ? await generateAIComment(postContent, aiContext) : comment;
            await xComment(page, postUrl, aiComment);
            results.push({ url: postUrl, success: true, comment: aiComment });
            await new Promise(resolve => setTimeout(resolve, 3000)); // Delay between comments
          } catch (error) {
            results.push({ url: postUrl, success: false, error: error.message });
          }
        }
        
        return { ok: true, message: `Auto-commented on ${results.filter(r => r.success).length} posts`, results };
      }

      if (action === 'like') {
        if (searchCriteria) {
          // Bulk like from search results
          const posts = await discoverXPosts(page, searchCriteria, maxPosts);
          const results = [];
          
          for (const postUrl of posts) {
            try {
              await xLike(page, postUrl);
              results.push({ url: postUrl, success: true });
              await new Promise(resolve => setTimeout(resolve, 5000)); // Longer delay between likes to avoid detection
            } catch (error) {
              results.push({ url: postUrl, success: false, error: error.message });
            }
          }
          
          return { ok: true, message: `Liked ${results.filter(r => r.success).length} X posts`, results };
        } else {
          // Single post like
          await xLike(page, url);
        }
      }
      if (action === 'comment') {
        const finalComment = useAI ? await generateAIComment('', aiContext) : comment;
        await xComment(page, url, finalComment);
      }
      if (action === 'follow') {
        await page.goto(url, { waitUntil: 'networkidle2' });
        const followed = await clickFirstMatching(page, ['[data-testid$="follow"]']) || await clickByText(page, ['Follow']);
        if (!followed) throw new Error('Could not find Follow button on X profile.');
      }
    }

    await saveSession(page, platform, sessionName);
    return { ok: true, message: `${platform} ${action} completed.` };
  } catch (error) {
    console.error('Error in runAction:', error);
    console.error('Error stack:', error.stack);
    console.error('Error details:', {
      message: error.message,
      name: error.name,
      cause: error.cause
    });
    return { ok: false, message: error.message || 'An unknown error occurred' };
  } finally {
    // Only close browser if not in headful mode
    if (!headful) {
      try {
        if (browser && !browser.isConnected()) {
          console.log('Browser already disconnected');
        } else if (browser) {
          await browser.close();
          console.log('Browser closed successfully');
        }
      } catch (closeError) {
        console.error('Error closing browser:', closeError);
      }
    } else {
      // For headful mode, keep browser open and log what happened
      console.log(`Browser kept open for headful mode. Action '${action}' completed on visible browser window.`);
    }
  }
}


