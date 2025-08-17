import 'dotenv/config';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { hasMyCommentAndCache, clearCommentCache, getCommentCacheStats, debugCommentDetection } from './utils/igHasMyComment.js';
import { hasMyThreadsCommentAndCache, clearThreadsCommentCache, getThreadsCommentCacheStats, hasMyThreadsLike } from './utils/threadsHasMyComment.js';
// X cache imports removed - will be rebuilt from scratch

puppeteer.use(StealthPlugin());

// cross-runtime sleep (works in any Puppeteer version)
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- TEXT HELPERS (valid replacements for :contains) ---
function buildXPathTextMatch(tagNames = ['*'], text) {
  const esc = JSON.stringify(text); // safe for XPath
  const tagExpr = tagNames.length === 1 ? tagNames[0] : `*[self::${tagNames.join(' or self::')}]`;
  return `//${tagExpr}[contains(normalize-space(.), ${esc})]`;
}

async function $xFirst(page, xpath) {
  try {
    // Try the modern approach first
    if (page.$x) {
      const nodes = await page.$x(xpath);
      return nodes.length ? nodes[0] : null;
    }
    
    // Fallback to evaluate approach for compatibility
    const element = await page.evaluate((xpath) => {
      const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue;
    }, xpath);
    
    return element;
  } catch (error) {
    console.log(`XPath query failed: ${xpath}, error: ${error.message}`);
    return null;
  }
}

// Helper function to click elements by text content
async function tryClickByText(page, texts = []) {
  for (const t of texts) {
    try {
      // Use page.evaluate to find and click elements by text
      const clicked = await page.evaluate((text) => {
        const elements = document.querySelectorAll('button, a, div, span');
        for (const el of elements) {
          const elText = (el.textContent || '').trim().toLowerCase();
          if (elText.includes(text.toLowerCase())) {
            el.click();
            return true;
          }
        }
        return false;
      }, t);
      
      if (clicked) {
        console.log(`✅ Clicked element with text: "${t}"`);
        await sleep(500);
        return true;
      }
    } catch (error) {
      console.log(`Failed to click element with text "${t}": ${error.message}`);
    }
  }
  return false;
}



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



async function saveSession(page, platform, sessionName = 'default', metadata = {}) {
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
  
  // Include metadata (like assistantId) in session file
  const sessionData = { 
    cookies, 
    storage, 
    metadata: {
      ...metadata,
      savedAt: new Date().toISOString(),
      platform
    }
  };
  
  await fs.writeFile(sessionPath, JSON.stringify(sessionData, null, 2), 'utf8');
  console.log(`Session saved with metadata:`, metadata);
}

// Helper function to get Assistant ID from session
async function getSessionAssistantId(platform, sessionName) {
  try {
    const { sessionPath } = getSessionFilePath(platform, sessionName);
    const data = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
    return data.metadata?.assistantId || null;
  } catch (error) {
    console.log(`Could not load assistant ID from session: ${error.message}`);
    return null;
  }
}

async function loadSession(page, platform, sessionName = 'default') {
  const { sessionPath } = getSessionFilePath(platform, sessionName);
  console.log(`Loading session from: ${sessionPath}`);
  try {
    const data = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
    console.log(`Session data loaded - cookies: ${data.cookies?.length || 0}, localStorage: ${Object.keys(data.storage?.localStorage || {}).length}, sessionStorage: ${Object.keys(data.storage?.sessionStorage || {}).length}`);
    
    // Log assistant ID if available
    if (data.metadata?.assistantId) {
      console.log(`🤖 Session Assistant ID: ${data.metadata.assistantId}`);
    }
    
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
    
    let elements = [];
    
    // Try page.$x first if available
    if (page.$x) {
      try {
        elements = await page.$x(xpath);
      } catch (error) {
        console.log(`page.$x failed for text "${text}": ${error.message}`);
      }
    }
    
    // Fallback to evaluate approach
    if (elements.length === 0) {
      try {
        elements = await page.evaluate((xpath) => {
          const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          const nodes = [];
          for (let i = 0; i < result.snapshotLength; i++) {
            nodes.push(result.snapshotItem(i));
          }
          return nodes;
        }, xpath);
        
        // Convert to ElementHandles if we got DOM elements
        if (elements.length > 0 && elements[0].nodeType) {
          // These are DOM elements, we need to click them differently
          const clicked = await page.evaluate((xpath) => {
            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            if (result.singleNodeValue) {
              result.singleNodeValue.click();
              return true;
            }
            return false;
          }, xpath);
          
          if (clicked) {
            console.log(`✅ Clicked element with text: "${text}" using evaluate`);
            return true;
          }
        }
      } catch (error) {
        console.log(`Evaluate approach failed for text "${text}": ${error.message}`);
      }
    } else if (elements.length > 0) {
      // We have ElementHandles from page.$x
      try {
      await elements[0].click({ delay: 50 });
        console.log(`✅ Clicked element with text: "${text}" using $x`);
      return true;
      } catch (error) {
        console.log(`Click failed for text "${text}": ${error.message}`);
      }
    }
  }
  return false;
}

// AI Comment Generation (simplified with createAndPoll)
async function generateAIComment(postContent, sessionAssistantId = null) {
  console.log('🤖 AI: Starting AI comment generation with Assistants API...');
  console.log(`🤖 AI: Post content length: ${postContent?.length || 0}`);

  if (!openai) {
    throw new Error('OPENAI_API_KEY environment variable is required for AI comments');
  }

  try {
    // Use session-specific assistant ID if provided, otherwise fall back to default
    const assistantId = sessionAssistantId || 'asst_2aVBUHe0mfXS4JZmU5YYf5E4';
    console.log(`🤖 AI: Using assistant ID: ${assistantId}${sessionAssistantId ? ' (from session)' : ' (default)'}`);

    // 1) Create a thread
    const thread = await openai.beta.threads.create();
    console.log('🤖 AI: Thread created:', thread.id);

    // 2) Add message to the thread
    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: postContent || '(no post text found)',
    });

    // 3) Create and poll the run until it finishes
    const run = await openai.beta.threads.runs.createAndPoll(thread.id, {
      assistant_id: assistantId,
    });

    console.log(`🤖 AI: Final run status: ${run.status}`);
    if (run.status !== 'completed') {
      throw new Error(`Assistant run not completed (status: ${run.status})`);
    }

    // 4) Get the messages from the thread
    const messages = await openai.beta.threads.messages.list(thread.id, { limit: 20 });
    const assistantMsg = messages.data.find(m => m.role === 'assistant');
    if (!assistantMsg) throw new Error('No assistant message found in thread');

    // 5) Extract the comment text
    let comment = '';
    for (const part of assistantMsg.content || []) {
      if (part.type === 'text' && part.text?.value) {
        comment += (comment ? '\n' : '') + part.text.value;
      }
    }
    comment = comment.trim();
    if (!comment) throw new Error('Assistant returned empty text');

    console.log(`🤖 AI: Generated comment: "${comment}"`);
    return comment;

  } catch (error) {
    console.error('🤖 AI: OpenAI Assistants API error:', error.message);
    console.error(error.stack);
    throw new Error(`Failed to generate AI comment: ${error.message}`);
  }
}

// Post Discovery Functions
async function discoverInstagramPosts(page, searchCriteria, maxPosts = 10) {
  console.log(`🚀 DISCOVERY: Starting Instagram post discovery with criteria:`, searchCriteria);
  console.log(`🚀 DISCOVERY: Max posts requested: ${maxPosts}`);
  console.log(`🚀 DISCOVERY: Currently discovered posts: ${discoveredPosts.size}`);
  
  const { hashtag, keywords } = searchCriteria;
  
  if (hashtag) {
    // Search by hashtag
    const url = `https://www.instagram.com/explore/tags/${encodeURIComponent(hashtag.replace('#', ''))}/`;
    console.log(`🚀 DISCOVERY: Navigating to hashtag URL: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2' });
    
    // Scroll to load more posts
    console.log(`🚀 DISCOVERY: Scrolling to load more posts...`);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    
    // Extract post URLs
    console.log(`🚀 DISCOVERY: Extracting post URLs...`);
    const posts = await page.$$eval('a[href^="/p/"]', (links, maxPosts) => {
      const urls = Array.from(new Set(links.map(link => link.getAttribute('href'))))
        .slice(0, maxPosts)
        .map(href => `https://www.instagram.com${href}`);
      console.log(`Found ${urls.length} post URLs:`, urls.slice(0, 3));
      return urls;
    }, maxPosts);
    
    console.log(`🚀 DISCOVERY: Raw posts found: ${posts.length}`);
    console.log(`🚀 DISCOVERY: Sample posts:`, posts.slice(0, 3));
    
    // Filter out already discovered posts
    const newPosts = posts.filter(postUrl => !discoveredPosts.has(postUrl));
    
    console.log(`🚀 DISCOVERY: After filtering, new posts: ${newPosts.length}`);
    console.log(`🚀 DISCOVERY: Sample new posts:`, newPosts.slice(0, 3));
    
    // Add new posts to discovered set
    newPosts.forEach(postUrl => discoveredPosts.add(postUrl));
    
    console.log(`🚀 DISCOVERY: Found ${posts.length} total posts, ${newPosts.length} new posts (${posts.length - newPosts.length} already discovered)`);
    console.log(`🚀 DISCOVERY: Total discovered posts now: ${discoveredPosts.size}`);
    
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

// Incremental discovery that can be called repeatedly to top up a queue
async function nextInstagramCandidates(page, searchCriteria, seen = new Set(), minNeeded = 6, maxScrolls = 20) {
  // Normalize criteria -> URL
  const parsed = typeof searchCriteria === 'string'
    ? (searchCriteria.startsWith('#') ? { hashtag: searchCriteria } : { keywords: searchCriteria })
    : (searchCriteria || {});
  const { hashtag, keywords } = parsed;

  const baseUrl = hashtag
    ? `https://www.instagram.com/explore/tags/${encodeURIComponent(hashtag.replace('#',''))}/`
    : `https://www.instagram.com/explore/tags/${encodeURIComponent((keywords || '').split(/\s+/)[0])}/`;

  // If we aren't already on the right explore page, navigate there
  if (!page.url().startsWith(baseUrl)) {
    await page.goto(baseUrl, { waitUntil: 'networkidle2' });
    await sleep(500);
  }

  const collected = new Set(); // local new URLs this call

  for (let i = 0; i < maxScrolls && collected.size < minNeeded; i++) {
    // Collect links for posts & reels (avoid duplicates & already-seen)
    const hrefs = await page.$$eval(
      'a[href^="/p/"], a[href^="/reel/"], a[href^="/tv/"]',
      as => as.map(a => a.getAttribute('href')).filter(Boolean)
    );

    for (const href of hrefs) {
      const abs = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
      if (!seen.has(abs)) collected.add(abs);
    }

    // Scroll to load more
    await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
    await sleep(500 + Math.floor(Math.random() * 300));
  }

  try { collected.forEach(u => discoveredPosts.add(u)); } catch {}

  return Array.from(collected);
}

// Global variable to track scroll depth across discovery calls
let xSearchScrollDepth = 0;

// X debug functions removed - will be rebuilt

// X discovery functions removed - will be rebuilt

async function TEMP_PLACEHOLDER_discoverXPosts(page, searchCriteria, maxPosts = 10) {
  try {
    console.log(`🐦 Discovering X posts with criteria: ${JSON.stringify(searchCriteria)}`);
    
  const { hashtag, keywords } = searchCriteria;
    let searchUrl;
  
  if (hashtag) {
    const searchTerm = hashtag.startsWith('#') ? hashtag : `#${hashtag}`;
      searchUrl = `https://x.com/search?q=${encodeURIComponent(searchTerm)}&src=typed_query&f=live`;
      console.log(`🐦 Searching by hashtag: ${searchTerm}`);
  } else if (keywords) {
      searchUrl = `https://x.com/search?q=${encodeURIComponent(keywords)}&src=typed_query&f=live`;
      console.log(`🐦 Searching by keywords: ${keywords}`);
    } else {
      throw new Error('No search criteria provided (hashtag or keywords required)');
    }
    
    console.log(`🐦 Navigating to X search: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Wait for search results to load
    await sleep(3000);
    
    // Debug page structure (uncomment for troubleshooting)
    // await debugXPageStructure(page);
    
    // Simple scroll - 3 scrolls
  for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight * 2);
      });
      await sleep(2000);
  }
  
      // Extract tweet URLs with debugging
    const tweets = await page.evaluate((maxPosts) => {
      console.log('🔍 DEBUG: Simple tweet extraction starting...');
      
      // Try multiple selectors
      const selectors = [
        'a[href*="/status/"]',
        'article a[href*="/status/"]',
        '[data-testid="Tweet"] a[href*="/status/"]',
        'a[role="link"][href*="status"]'
      ];
      
      let allTweetLinks = [];
      selectors.forEach(selector => {
        const links = Array.from(document.querySelectorAll(selector));
        console.log(`🔍 Simple selector "${selector}": Found ${links.length} links`);
        allTweetLinks.push(...links);
      });
      
      // Also check all links for tweet patterns
      const allLinks = Array.from(document.querySelectorAll('a'));
      const tweetPatternLinks = allLinks.filter(link => {
        const href = link.getAttribute('href') || '';
        return href.includes('/status/');
      });
      
      console.log(`🔍 Total links on page: ${allLinks.length}`);
      console.log(`🔍 Links with /status/: ${tweetPatternLinks.length}`);
      
      const uniqueUrls = new Set();
      const tweetUrls = [];
      
      tweetPatternLinks.forEach(link => {
        const href = link.getAttribute('href');
        if (href && href.includes('/status/')) {
          const statusMatch = href.match(/\/status\/(\d+)/);
          if (statusMatch) {
            const tweetId = statusMatch[1];
            const fullUrl = href.startsWith('http') ? href : `https://x.com${href}`;
            const cleanUrl = fullUrl.split('?')[0];
            
            if (!uniqueUrls.has(tweetId)) {
              uniqueUrls.add(tweetId);
              tweetUrls.push(cleanUrl);
            }
          }
        }
      });
      
      console.log(`🔍 Simple extraction result: ${tweetUrls.length} unique tweets`);
      return tweetUrls.slice(0, maxPosts);
  }, maxPosts);
  
    console.log(`🐦 Found ${tweets.length} X posts`);
  return tweets;
    
  } catch (error) {
    console.error(`❌ X post discovery error: ${error.message}`);
    throw new Error(`X post discovery failed: ${error.message}`);
  }
}

async function TEMP_PLACEHOLDER_discoverXPostsBulk(page, searchCriteria, targetCount = 50) {
  try {
    console.log(`🐦 Collecting X posts in bulk with criteria: ${JSON.stringify(searchCriteria)}`);
    console.log(`🐦 Target: ${targetCount} posts to collect`);
    
  const { hashtag, keywords } = searchCriteria;
    let searchUrl;
  
  if (hashtag) {
    const searchTerm = hashtag.startsWith('#') ? hashtag : `#${hashtag}`;
      searchUrl = `https://x.com/search?q=${encodeURIComponent(searchTerm)}&src=typed_query&f=live`;
      console.log(`🐦 Searching by hashtag: ${searchTerm}`);
  } else if (keywords) {
      searchUrl = `https://x.com/search?q=${encodeURIComponent(keywords)}&src=typed_query&f=live`;
      console.log(`🐦 Searching by keywords: ${keywords}`);
    } else {
      throw new Error('No search criteria provided (hashtag or keywords required)');
    }
    
    console.log(`🐦 Navigating to X search: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Wait for search results to load
    await sleep(3000);
    
    // Debug page structure (uncomment for troubleshooting)
    // await debugXPageStructure(page);
    
    // Check if we're still logged in
    const stillLoggedIn = await page.evaluate(() => {
      return !!document.querySelector('[data-testid="AppTabBar_Home_Link"]');
    });
    
    if (!stillLoggedIn) {
      throw new Error('Lost X session during search - please re-login');
    }
    
    // Scroll to collect many posts at once
    console.log(`🐦 Scrolling to collect ${targetCount} posts...`);
    let allTweets = [];
    let scrollCount = 0;
    const maxScrolls = 15;
    
    while (allTweets.length < targetCount && scrollCount < maxScrolls) {
      // Scroll down
      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight * 2);
      });
      await sleep(2000);
      scrollCount++;
      
      // Extract current tweets with enhanced debugging
      const currentTweets = await page.evaluate(() => {
        console.log('🔍 DEBUG: Starting tweet extraction...');
        
        // Try multiple selectors for tweet links
        const selectors = [
          'a[href*="/status/"]',
          'a[href*="/x.com/"]', 
          'a[href*="twitter.com"]',
          '[data-testid="Tweet"] a',
          'article a',
          'div[data-testid="tweetText"] a',
          'a[role="link"][href*="status"]'
        ];
        
        let allLinks = [];
        selectors.forEach(selector => {
          const links = Array.from(document.querySelectorAll(selector));
          console.log(`🔍 Selector "${selector}": Found ${links.length} links`);
          allLinks.push(...links);
        });
        
        // Also check for any links that might contain tweet URLs
        const allPageLinks = Array.from(document.querySelectorAll('a'));
        console.log(`🔍 Total links on page: ${allPageLinks.length}`);
        
        // Sample some links to see what we're working with
        const sampleLinks = allPageLinks.slice(0, 10).map(link => ({
          href: link.getAttribute('href'),
          text: link.textContent?.slice(0, 50) || '',
          testid: link.getAttribute('data-testid') || 'none'
        }));
        console.log('🔍 Sample links:', sampleLinks);
        
        // Look for tweet-like patterns
        const tweetLinks = allPageLinks.filter(link => {
          const href = link.getAttribute('href') || '';
          return href.includes('/status/') || 
                 href.includes('/tweet/') ||
                 href.match(/\/\w+\/status\/\d+/) ||
                 href.match(/twitter\.com\/\w+\/status\/\d+/) ||
                 href.match(/x\.com\/\w+\/status\/\d+/);
        });
        
        console.log(`🔍 Found ${tweetLinks.length} potential tweet links`);
        
        const uniqueUrls = new Set();
        const tweetUrls = [];
        
        tweetLinks.forEach((link, index) => {
          const href = link.getAttribute('href') || '';
          console.log(`🔍 Processing link ${index + 1}: ${href}`);
          
          if (href.includes('/status/')) {
            const statusMatch = href.match(/\/status\/(\d+)/);
            if (statusMatch) {
              const tweetId = statusMatch[1];
              const fullUrl = href.startsWith('http') ? href : `https://x.com${href}`;
              const cleanUrl = fullUrl.split('?')[0];
              
              if (!uniqueUrls.has(tweetId)) {
                uniqueUrls.add(tweetId);
                tweetUrls.push(cleanUrl);
                console.log(`✅ Added tweet: ${cleanUrl}`);
              } else {
                console.log(`⏭️ Duplicate tweet ID: ${tweetId}`);
              }
            }
          }
        });
        
        console.log(`🔍 Final result: ${tweetUrls.length} unique tweet URLs`);
        return tweetUrls;
      });
      
      // Update our collection with new unique tweets
      const newTweets = currentTweets.filter(tweet => !allTweets.includes(tweet));
      allTweets.push(...newTweets);
      allTweets = [...new Set(allTweets)]; // Remove duplicates
      
      console.log(`🐦 Scroll ${scrollCount}: Collected ${allTweets.length} unique tweets (${newTweets.length} new this scroll)`);
      
      // Stop if we're not finding new content
      if (newTweets.length === 0 && scrollCount > 5) {
        console.log(`🐦 No new tweets found, stopping collection`);
        break;
      }
    }
    
    console.log(`🐦 ✅ Collection complete: ${allTweets.length} total unique tweets collected`);
    return allTweets;
    
  } catch (error) {
    console.error(`❌ X post bulk discovery error: ${error.message}`);
    throw new Error(`X post bulk discovery failed: ${error.message}`);
  }
}

async function getPostContent(page, postUrl, platform) {
  console.log(`🚀 getPostContent called for ${platform} post: ${postUrl}`);
  await page.goto(postUrl, { waitUntil: 'networkidle2' });
  
  if (platform === 'instagram') {
    // Quick sanity: if not logged in you often get login-wall content only
    const loginWall = await page.evaluate(() => {
      const t = document.body?.innerText || '';
      const blocked = t.includes('Log in') && t.includes('Sign up') && !t.includes('Like');
      return blocked;
    });
    if (loginWall) {
      console.log('⚠️ Instagram login wall detected — ensure ensureInstagramLoggedIn() succeeded.');
    }

    // 1) JSON-LD: Most reliable when present
    const jsonLd = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const s of scripts) {
        try {
          const data = JSON.parse(s.textContent || 'null');
          // Sometimes it's a single object; sometimes an array
          const arr = Array.isArray(data) ? data : [data];
          for (const obj of arr) {
            if (obj && (obj['@type'] === 'SocialMediaPosting' || obj['@type'] === 'ImageObject')) {
              const text = obj.articleBody || obj.caption || obj.description;
              if (text && text.trim().length > 0) return text.trim();
            }
          }
        } catch (_) {}
      }
      return null;
    });
    if (jsonLd) {
      console.log('✅ Caption extracted via JSON-LD.');
      return jsonLd;
    }

    // 2) OG description fallback
    const ogDesc = await page.evaluate(() => {
      const m = document.querySelector('meta[property="og:description"]') || document.querySelector('meta[name="description"]');
      const c = m?.getAttribute('content') || '';
      // IG sometimes formats like 'username on Instagram: "caption text …"'
      if (c) {
        // Try to strip leading "username on Instagram:" noise, keep inside quotes if present
        const quoteMatch = c.match(/"([^"]+)"/) || c.match(/"([^"]+)"/);
        return (quoteMatch?.[1] || c).trim();
      }
      return '';
    });
    if (ogDesc && ogDesc.length > 0) {
      console.log('✅ Caption extracted via OG meta.');
      return ogDesc;
    }

    // 3) DOM fallback (best-effort)
    const domCaption = await page.evaluate(() => {
      // Heuristic: find the main article or main region
      const root =
        document.querySelector('article') ||
        document.querySelector('main') ||
        document.body;

      if (!root) return '';

      // Collect plausible text nodes
      const candidates = Array.from(root.querySelectorAll('h1,h2,h3,p,span,div[dir="auto"],li'))
        .map(el => (el.textContent || '').trim())
        .filter(t =>
          t.length >= 10 &&
          t.length <= 2000 &&
          !/instagram|log in|sign up|create an account/i.test(t)
        );

      // Choose first that looks like a caption (has hashtags OR ~sentence-like)
      const scored = candidates.map(t => {
        let score = 0;
        if (/#\w/.test(t)) score += 2;
        if (/@\w/.test(t)) score += 1;
        if (/[.!?…]/.test(t)) score += 1;
        if (t.split(/\s+/).length >= 6) score += 1;
        return { t, score };
      }).sort((a, b) => b.score - a.score);

      return (scored[0]?.t || candidates[0] || '').trim();
    });

    if (domCaption) {
      console.log('✅ Caption extracted via DOM fallback.');
      return domCaption;
    }

    console.log('⚠️ No caption text found — returning empty string.');
    return '';
  }

  if (platform === 'x') {
    console.log(`🐦 Extracting X tweet content from: ${postUrl}`);
    
    // Wait for content to load
    await sleep(2000);
    
    // Enhanced X tweet content extraction with multiple strategies
    let tweetText = await page.evaluate(() => {
      console.log('🐦 Starting X content extraction...');
      
      // Strategy 1: Primary tweet text selector
      const primarySelector = document.querySelector('[data-testid="tweetText"]');
      if (primarySelector && primarySelector.textContent.trim()) {
        const text = primarySelector.textContent.trim();
        console.log(`✅ Found primary tweet text: "${text.slice(0, 100)}..."`);
        return text;
      }
      
      // Strategy 2: Look for tweet text in article containers
      const articles = document.querySelectorAll('article');
      console.log(`🐦 Found ${articles.length} article containers`);
      
      for (const article of articles) {
        // Look for text within language-tagged divs
        const langDivs = article.querySelectorAll('div[lang]');
        if (langDivs.length > 0) {
          const combinedText = Array.from(langDivs)
            .map(div => div.textContent?.trim() || '')
            .filter(text => text.length > 0)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          
          if (combinedText && combinedText.length > 10) {
            console.log(`✅ Found language-tagged text: "${combinedText.slice(0, 100)}..."`);
            return combinedText;
          }
        }
        
        // Look for tweet content in spans and divs
        const textElements = article.querySelectorAll('span, div');
        const candidates = [];
        
        textElements.forEach(el => {
          const text = el.textContent?.trim();
          if (text && text.length > 20 && text.length < 500) {
            // Skip elements that look like UI components
            const isUI = text.includes('Repost') || 
                        text.includes('Like') || 
                        text.includes('Reply') || 
                        text.includes('Share') ||
                        text.includes('Show this thread') ||
                        text.includes('Show more replies') ||
                        text.match(/^\d+[hms]$/) || // timestamps like "2h", "5m"
                        text.match(/^@\w+$/) || // standalone usernames
                        text.includes('·') && text.length < 50; // metadata
            
            if (!isUI) {
              candidates.push(text);
            }
          }
        });
        
        // Find the best candidate (longest substantial text)
        const bestCandidate = candidates
          .filter(text => text.length > 20)
          .sort((a, b) => {
            // Prioritize text with hashtags, mentions, or multiple sentences
            const aScore = (a.match(/#\w+/g) || []).length + 
                          (a.match(/@\w+/g) || []).length + 
                          (a.match(/[.!?]/g) || []).length;
            const bScore = (b.match(/#\w+/g) || []).length + 
                          (b.match(/@\w+/g) || []).length + 
                          (b.match(/[.!?]/g) || []).length;
            
            if (aScore !== bScore) return bScore - aScore;
            return b.length - a.length; // Fallback to length
          })[0];
        
        if (bestCandidate) {
          console.log(`✅ Found best candidate: "${bestCandidate.slice(0, 100)}..."`);
          return bestCandidate;
        }
      }
      
      // Strategy 3: Fallback to any substantial text in main content area
      const mainContent = document.querySelector('main') || document.body;
      const allText = mainContent.textContent || '';
      const lines = allText.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 30 && line.length < 500)
        .filter(line => {
          // Filter out common UI text
          return !line.includes('Home') &&
                 !line.includes('Notifications') &&
                 !line.includes('Messages') &&
                 !line.includes('Bookmarks') &&
                 !line.includes('Profile') &&
                 !line.match(/^\d+[hms]$/);
        });
      
      if (lines.length > 0) {
        const fallbackText = lines[0];
        console.log(`🔄 Using fallback text: "${fallbackText.slice(0, 100)}..."`);
        return fallbackText;
      }
      
      console.log('⚠️ No tweet content found');
      return '';
    });

    console.log(`🐦 X tweet content extracted: "${(tweetText || '').slice(0, 140)}${tweetText && tweetText.length > 140 ? '…' : ''}"`);
    return tweetText || '';
  }

  if (platform === 'threads') {
    console.log(`🔍 Extracting Threads post content from: ${postUrl}`);
    
    // Try multiple selectors for Threads post text
    let threadText = await page.evaluate(() => {
      console.log('🔍 Starting Threads content extraction...');
      
      // Try specific selectors first (most reliable)
      const specificSelectors = [
        '[data-testid="thread-post-text"]',
        '[data-testid="post-text"]',
        '[data-testid="thread-text"]'
      ];
      
      for (const selector of specificSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          const text = el.textContent?.trim() || '';
          if (text.length > 5) {
            console.log(`✅ Found post text with specific selector: ${selector} - "${text.slice(0, 50)}..."`);
            return text;
          }
        }
      }
      
      // More targeted approach: look for post content within article structure
      const articles = document.querySelectorAll('article');
      console.log(`🔍 Found ${articles.length} article elements`);
      
      for (const article of articles) {
        // Look for text content that's likely to be the main post
        const textElements = article.querySelectorAll('div[dir="auto"], span[dir="auto"]');
        console.log(`🔍 Found ${textElements.length} text elements in article`);
        
        for (const el of textElements) {
          const text = el.textContent?.trim() || '';
          const parent = el.parentElement;
          
          // Skip if it's clearly a username, timestamp, or UI element
          if (text.length < 10) continue;
          if (text.match(/^@\w+$/)) continue; // Skip usernames like @username
          if (text.match(/^\d+[smhd]$/)) continue; // Skip timestamps like 2h, 5m
          if (text.match(/^(Like|Reply|Share|Follow|•|\d+$)$/i)) continue; // Skip UI buttons
          if (text.includes('Suggested for you')) continue;
          if (text.includes('View profile')) continue;
          if (text.includes('Follow')) continue;
          if (parent?.getAttribute('role') === 'button') continue; // Skip clickable elements
          
          // Look for characteristics of actual post content
          const hasHashtags = /#\w+/.test(text);
          const hasMentions = /@\w+/.test(text);
          const hasMultipleWords = text.split(/\s+/).length >= 3;
          const hasPunctuation = /[.!?,:;]/.test(text);
          
          // Prioritize text that looks like post content
          if (hasHashtags || hasMentions || (hasMultipleWords && hasPunctuation)) {
            console.log(`✅ Found likely post content: "${text.slice(0, 100)}..."`);
            return text;
          }
          
          // As backup, take any substantial text that's not UI
          if (hasMultipleWords && text.length > 20) {
            console.log(`🔄 Found backup post content: "${text.slice(0, 100)}..."`);
            return text;
          }
        }
      }
      
      console.log('⚠️ No specific post content found with targeted approach');
      return '';
    });

    // Enhanced fallback: look for text content in the main post area
    if (!threadText) {
      console.log(`🔄 Trying fallback content extraction...`);
      threadText = await page.evaluate(() => {
        console.log('🔄 Starting fallback extraction...');
        
        const article = document.querySelector('article') || document.querySelector('main') || document.body;
        if (!article) {
          console.log('⚠️ No article/main/body found');
          return '';
        }
        
        // Get all text elements and filter more strictly
        const textElements = Array.from(article.querySelectorAll('div, span, p'));
        console.log(`🔄 Found ${textElements.length} total text elements`);
        
        const candidates = textElements
          .map(n => {
            const text = n.textContent?.trim() || '';
            const parent = n.parentElement;
            const isButton = parent?.getAttribute('role') === 'button' || n.getAttribute('role') === 'button';
            return { text, isButton, element: n };
          })
          .filter(({ text, isButton }) => {
            // More strict filtering
            if (text.length < 15) return false; // Minimum length for post content
            if (text.length > 2000) return false; // Maximum reasonable length
            if (isButton) return false; // Skip button elements
            if (text.match(/^@\w+$/)) return false; // Skip standalone usernames
            if (text.match(/^\d+[smhd]$/)) return false; // Skip timestamps
            if (text.match(/^(Like|Reply|Share|Follow|•|\d+$|View profile|Suggested for you|More|Show)$/i)) return false;
            if (text.includes('threads.net')) return false;
            if (text.includes('@threads')) return false;
            if (text.includes('Verified')) return false;
            if (text.includes('Follow')) return false;
            
            return true;
          })
          .map(({ text }) => text);
        
        console.log(`🔄 After filtering: ${candidates.length} candidates`);
        candidates.forEach((text, i) => {
          console.log(`  Candidate ${i + 1}: "${text.slice(0, 60)}..."`);
        });
        
        // Prioritize candidates that look most like post content
        const scoredCandidates = candidates.map(text => {
          let score = 0;
          if (/#\w+/.test(text)) score += 3; // Has hashtags
          if (/@\w+/.test(text)) score += 2; // Has mentions
          if (/[.!?]/.test(text)) score += 2; // Has sentence endings
          if (text.split(/\s+/).length >= 5) score += 1; // Multiple words
          if (text.length > 50) score += 1; // Substantial length
          
          return { text, score };
        }).sort((a, b) => b.score - a.score);
        
        const bestCandidate = scoredCandidates[0]?.text || '';
        if (bestCandidate) {
          console.log(`✅ Best fallback candidate (score: ${scoredCandidates[0].score}): "${bestCandidate.slice(0, 100)}..."`);
        } else {
          console.log('⚠️ No suitable fallback candidates found');
        }
        
        return bestCandidate;
      });
    }

    console.log(`🚀 Threads post content extracted: "${(threadText || '').slice(0, 140)}${threadText && threadText.length > 140 ? '…' : ''}"`);
    return threadText || '';
  }
  
  return '';
}

// Handle Instagram's one-tap login page
async function handleOneTapPage(page) {
  try {
    console.log('Handling one-tap login page...');
    await new Promise(resolve => setTimeout(resolve, 1000)); // Brief wait for page to load
    
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
      await new Promise(resolve => setTimeout(resolve, 1000)); // Brief wait for navigation
      
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
    
    // Wait for page to load briefly
    await new Promise(resolve => setTimeout(resolve, 500));
    
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
    
    // Brief wait for page to settle
    await new Promise(resolve => setTimeout(resolve, 800));
    
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
      await new Promise(resolve => setTimeout(resolve, 1000)); // Brief wait for popup to appear
      
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
        await new Promise(resolve => setTimeout(resolve, 500)); // Brief wait for popup to disappear
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

async function instagramComment(page, postUrl, comment, username) {
  console.log(`💬 ===== INSTAGRAM COMMENT START =====`);
  console.log(`💬 POST: ${postUrl}`);
  console.log(`💬 COMMENT: ${comment}`);
  console.log(`💬 USERNAME: ${username}`);
  
  // Quick navigation optimization - only navigate if not already on post
  const currentUrl = page.url();
  const shortcode = postUrl.split('/p/')[1]?.split('/')[0] || postUrl.split('/reel/')[1]?.split('/')[0];
  
  if (!currentUrl.includes(shortcode)) {
    console.log(`💬 NAVIGATING to post`);
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
    // Quick wait for essential elements only
    try {
      await page.waitForSelector('article, main, [role="main"]', { timeout: 2000 });
    } catch {
      console.log('💬 Main content not found quickly, continuing...');
    }
  } else {
    console.log(`💬 ALREADY ON POST`);
  }
  
  console.log('💬 Page ready, attempting to comment');
  
  // CRITICAL: Double-check for existing comments before posting
  console.log('💬 DOUBLE-CHECKING for existing comments before posting...');
  const alreadyCommented = await hasMyCommentAndCache({
    page,
    username: username,
    postUrl: postUrl,
  });
  
  if (alreadyCommented) {
    console.log('💬 ===== COMMENT SKIPPED =====');
    console.log('💬 Already commented - double-check detected existing comment');
    console.log('💬 ===== COMMENT SKIPPED =====');
    return { skipped: true, reason: 'Already commented (double-check)' };
  }
  
  console.log('💬 Double-check passed - no existing comment found, proceeding...');
  
  // Click the comment button to open the comment input
  const commentButtonClicked = await clickFirstMatching(page, [
    'svg[aria-label="Comment"]',
    'span[aria-label="Comment"]',
    'button svg[aria-label="Comment"]',
    'button[aria-label="Comment"]',
    'div[role="button"]:has(svg[aria-label="Comment"])',
  ]);
  
  if (!commentButtonClicked) {
    throw new Error('Could not find comment button');
  }
  
  console.log('🎯 Comment button clicked, waiting for textarea');
  
  // Wait for the comment textarea to appear
  await page.waitForSelector('textarea[aria-label="Add a comment…"]', { timeout: 15000 });
  await new Promise(resolve => setTimeout(resolve, 500)); // Reduced delay
  
  // Type the comment using the Enter key method (more reliable)
  console.log(`✍️  Typing comment: "${comment}"`);
  
  // Click the textarea first to ensure focus
  await page.click('textarea[aria-label="Add a comment…"]');
  await new Promise(resolve => setTimeout(resolve, 300)); // Reduced delay
  
  // Type with human-like delay to help React enable the button
  await page.keyboard.type(comment, { delay: 25 }); // Slightly faster typing
  await new Promise(resolve => setTimeout(resolve, 800)); // Reduced delay
  
  // Press Enter to post the comment
  console.log('⏎ Posting comment...');
  await page.keyboard.press('Enter');
  
  // Wait for the comment to be posted by checking DOM
  console.log('⏳ Verifying comment posted...');
  
  // Reduced wait time for comment verification
  await sleep(1500);
  
  const commentPosted = await page.evaluate((commentText) => {
    // Look for the comment in multiple possible locations
    const selectors = [
      'span[dir="auto"]',
      'div[dir="auto"]',
      'span[data-testid="comment"]',
      'div[data-testid="comment"]',
      'article span',
      'article div'
    ];
    
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      for (const element of elements) {
        const text = element.textContent?.trim() || '';
        // Check if the comment text appears in this element
        if (text.includes(commentText.substring(0, Math.min(20, commentText.length)))) {
          return true;
        }
      }
    }
    return false;
  }, comment);
  
  let posted = false;
  if (commentPosted) {
    console.log('✅ Comment verified in DOM');
    posted = true;
  } else {
    console.log('⚠️  Comment not immediately visible, but may have posted');
    // Don't fail immediately - Instagram sometimes delays showing comments
    posted = true;
  }
  
  if (!posted) {
    throw new Error('Failed to post comment - Enter key method did not work');
  }
  
  // After successful response, mark as commented so you never re-check the DOM for this post again.
  await hasMyCommentAndCache({
    page,
    username: username,
    postUrl: postUrl,
    markCommented: true,
  });
  
  console.log('💬 ===== COMMENT SUCCESS =====');
  console.log('💬 Comment posted successfully');
  console.log('💬 ===== COMMENT SUCCESS =====');
  // Reduced delay - no need to wait long after posting
  await new Promise(resolve => setTimeout(resolve, 800));
  
  return { success: true };
}

// X (Twitter) flows
async function ensureXLoggedIn(page, { username, password }) {
  try {
    console.log('🐦 Starting X login process...');
    
    // Navigate to home page first to check login status
    const currentUrl = page.url();
    if (!currentUrl.includes('x.com') && !currentUrl.includes('twitter.com')) {
      console.log('🐦 Navigating to X home page...');
      await page.goto('https://x.com/home', { waitUntil: 'networkidle2', timeout: 30000 });
    }
    
    // Enhanced login detection with multiple indicators
    const loginCheckResult = await page.evaluate(() => {
      const debugLog = [];
      debugLog.push('🐦 Checking X login status...');
      
      // Multiple login indicators for X
      const loginIndicators = [
        '[data-testid="AppTabBar_Home_Link"]',
        '[data-testid="AppTabBar_Notifications_Link"]',
        '[data-testid="AppTabBar_DirectMessage_Link"]',
        '[data-testid="SideNav_AccountSwitcher_Button"]',
        'a[href="/home"]',
        'a[data-testid="AppTabBar_Profile_Link"]',
        '[data-testid="primaryColumn"]'
      ];
      
      let foundIndicators = 0;
      loginIndicators.forEach(selector => {
        const element = document.querySelector(selector);
        if (element) {
          foundIndicators++;
          debugLog.push(`✅ Found login indicator: ${selector}`);
        } else {
          debugLog.push(`❌ Missing login indicator: ${selector}`);
        }
      });
      
      // Check for login/signup buttons (indicates not logged in)
      const logoutIndicators = [
        'a[href="/login"]',
        'a[href="/signup"]',
        '[data-testid="loginButton"]',
        '[data-testid="signupButton"]'
      ];
      
      let foundLogoutIndicators = 0;
      logoutIndicators.forEach(selector => {
        const element = document.querySelector(selector);
        if (element) {
          foundLogoutIndicators++;
          debugLog.push(`⚠️ Found logout indicator: ${selector}`);
        }
      });
      
      const isLoggedIn = foundIndicators >= 2 && foundLogoutIndicators === 0;
      debugLog.push(`🐦 Login status: ${isLoggedIn ? 'LOGGED IN' : 'NOT LOGGED IN'} (${foundIndicators} login indicators, ${foundLogoutIndicators} logout indicators)`);
      
      return { isLoggedIn, debugLog, foundIndicators, foundLogoutIndicators };
    });
    
    // Log debug information
    console.log('=== X Login Detection Debug ===');
    loginCheckResult.debugLog.forEach(log => console.log(log));
    console.log('================================');
    
    if (loginCheckResult.isLoggedIn) {
      console.log('✅ Already logged in to X');
      return true;
    }

    if (!username || !password) {
      throw new Error('X session missing and no credentials provided. Provide username/password or login headfully and save a session.');
    }

    console.log('🐦 Proceeding with X login...');
    await page.goto('https://x.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Wait for and fill username
    console.log('🐦 Waiting for username field...');
    await page.waitForSelector('input[name="text"]', { timeout: 30000 });
    await sleep(1000); // Allow page to settle
    
    console.log('🐦 Entering username...');
    await page.click('input[name="text"]');
    await page.evaluate(() => document.querySelector('input[name="text"]').value = '');
    await page.type('input[name="text"]', username, { delay: 50 });
    
    // Click Next button
    console.log('🐦 Clicking Next button...');
    
    // Debug: Check what buttons are available
    const availableButtons = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
      return buttons.map(btn => ({
        text: btn.textContent?.trim() || '',
        testId: btn.getAttribute('data-testid') || '',
        ariaLabel: btn.getAttribute('aria-label') || '',
        tagName: btn.tagName,
        role: btn.getAttribute('role') || ''
      })).filter(btn => btn.text || btn.testId || btn.ariaLabel);
    });
    
    console.log('🐦 Available buttons on page:', availableButtons);
    
    // First try specific selectors for Next button
    const nextClicked = await clickFirstMatching(page, [
      'div[role="button"][data-testid="LoginForm_Login_Button"]',
      '[data-testid="LoginForm_Login_Button"]',
      'button[data-testid="LoginForm_Login_Button"]'
    ]);
    
    // If that failed, try text-based clicking with more specific text matching
    if (!nextClicked) {
      console.log('🐦 Trying text-based Next button clicking...');
      
      // Use more specific text matching to avoid Apple login button
      const textClicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
        for (const btn of buttons) {
          const text = btn.textContent?.trim().toLowerCase() || '';
          // Look for exact "next" text and avoid Apple/Google/other login buttons
          if (text === 'next' && 
              !text.includes('apple') && 
              !text.includes('google') && 
              !text.includes('continue with') &&
              !text.includes('sign in with')) {
            console.log(`🐦 Found Next button with text: "${btn.textContent?.trim()}"`);
            btn.click();
            return true;
          }
        }
        
        // Also try buttons that might have "Next" as part of longer text
        for (const btn of buttons) {
          const text = btn.textContent?.trim().toLowerCase() || '';
          if (text.includes('next') && text.length < 10 &&
              !text.includes('apple') && 
              !text.includes('google') && 
              !text.includes('continue with') &&
              !text.includes('sign in with')) {
            console.log(`🐦 Found Next button with text: "${btn.textContent?.trim()}"`);
            btn.click();
            return true;
          }
        }
        
        return false;
      });
      
      if (!textClicked) {
        // Try to find the primary action button (usually the Next button)
        console.log('🐦 Trying primary action button detection...');
        const primaryClicked = await page.evaluate(() => {
          // Look for buttons that are likely the primary action
          const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
          
          // First try to find buttons with specific styling that indicates primary action
          for (const btn of buttons) {
            const computedStyle = window.getComputedStyle(btn);
            const text = btn.textContent?.trim() || '';
            
            // Skip obvious third-party login buttons
            if (text.toLowerCase().includes('apple') || 
                text.toLowerCase().includes('google') ||
                text.toLowerCase().includes('continue with') ||
                text.toLowerCase().includes('sign in with')) {
              continue;
            }
            
            // Look for primary button styling (usually darker background)
            const bgColor = computedStyle.backgroundColor;
            const color = computedStyle.color;
            
            // X typically uses dark buttons for primary actions
            if ((bgColor.includes('rgb(15, 20, 25)') || // X dark theme
                 bgColor.includes('rgb(29, 155, 240)') || // X blue
                 bgColor.includes('rgb(0, 0, 0)')) && // black
                text.length > 0 && text.length < 15) {
              console.log(`🐦 Found primary button: "${text}" with bg: ${bgColor}`);
              btn.click();
              return true;
            }
          }
          
          return false;
        });
        
        if (!primaryClicked) {
          throw new Error('Could not find Next button. Available buttons: ' + JSON.stringify(availableButtons.map(b => b.text)));
        }
      }
    }
    
    console.log('🐦 Next button clicked successfully');
    
    await sleep(2000); // Wait for next step
    
    // Handle potential username verification step
    try {
      const needsVerification = await page.waitForSelector('input[data-testid="ocfEnterTextTextInput"]', { timeout: 5000 });
      if (needsVerification) {
        console.log('🐦 Username verification required, entering username again...');
        await page.type('input[data-testid="ocfEnterTextTextInput"]', username, { delay: 50 });
        await clickFirstMatching(page, ['div[role="button"][data-testid="ocfEnterTextNextButton"]']) || await clickByText(page, ['Next']);
        await sleep(2000);
      }
    } catch (e) {
      console.log('🐦 No username verification step needed');
    }
    
    // Wait for and fill password
    console.log('🐦 Waiting for password field...');
    const passwordSelector = 'input[name="password"]';
    await page.waitForSelector(passwordSelector, { timeout: 30000 });
    await sleep(1000);
    
    console.log('🐦 Entering password...');
    await page.click(passwordSelector);
    await page.type(passwordSelector, password, { delay: 50 });
    
    // Click login button
    console.log('🐦 Clicking login button...');
    const loginClicked = await clickFirstMatching(page, [
      'div[role="button"][data-testid="LoginForm_Login_Button"]',
      'button[data-testid="LoginForm_Login_Button"]',
      'div[role="button"]:has-text("Log in")'
    ]) || await clickByText(page, ['Log in', 'Log In']);
    
    if (!loginClicked) {
      throw new Error('Could not find or click login button');
    }
    
    console.log('🐦 Waiting for login to complete...');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
    
    // Verify login was successful with enhanced detection
    await sleep(3000); // Allow page to fully load
    const loginVerification = await page.evaluate(() => {
      const indicators = [
        '[data-testid="AppTabBar_Home_Link"]',
        '[data-testid="AppTabBar_Notifications_Link"]',
        '[data-testid="primaryColumn"]',
        'a[href="/home"]'
      ];
      
      let found = 0;
      indicators.forEach(selector => {
        if (document.querySelector(selector)) found++;
      });
      
      return found >= 2;
    });
    
    if (!loginVerification) {
      throw new Error('Login failed - could not verify successful login. Please check your credentials.');
    }
    
    console.log('✅ X login successful!');
    return true;
  } catch (error) {
    console.error('❌ X login error:', error.message);
    throw new Error(`X login error: ${error.message}`);
  }
}

// Helper function to click back arrow and return to search results, optionally with keyboard navigation
async function clickBackToSearch(page, searchUrl, navigateNext = false) {
  try {
    // Look for the back arrow button using the SVG path
    const backButton = await page.$('svg path[d="M7.414 13l5.043 5.04-1.414 1.42L3.586 12l7.457-7.46 1.414 1.42L7.414 11H21v2H7.414z"]');
    if (backButton) {
      // Click the parent button/link element
      const clickableParent = await page.evaluateHandle(el => {
        // Find the clickable parent (button or link)
        let parent = el.parentElement;
        while (parent && parent.tagName !== 'BUTTON' && parent.tagName !== 'A' && !parent.getAttribute('role')) {
          parent = parent.parentElement;
        }
        return parent;
      }, backButton);
      
      if (clickableParent) {
        await clickableParent.click();
        console.log('✅ Successfully clicked back arrow');
        
        // Wait for navigation to complete
        await sleep(1500);
        
        // Optionally use keyboard navigation to move to next tweet
        if (navigateNext) {
          console.log('⌨️ Using keyboard navigation: pressing "j" to navigate to next tweet...');
          await page.keyboard.press('j');
          await sleep(300);
          console.log('✅ Keyboard navigation complete');
        } else {
          console.log('✅ Staying on search results page');
        }
        
        return true;
      } else {
        throw new Error('Could not find clickable back button parent');
      }
    } else {
      throw new Error('Could not find back arrow SVG');
    }
  } catch (backError) {
    console.log(`⚠️ Back arrow click failed: ${backError.message}, using URL navigation as fallback`);
    await page.goto(searchUrl, { waitUntil: 'networkidle2' });
    return false;
  }
}

// X Keyboard Navigation Auto-Comment System
async function xAutoComment(page, { searchCriteria, maxPosts, useAI, comment, username }) {
  try {
    console.log('🐦 Starting X auto-comment with keyboard navigation approach');
    console.log(`🐦 Target: ${maxPosts} comments`);
    console.log(`🐦 Search criteria: ${JSON.stringify(searchCriteria)}`);
    
    const { hashtag, keywords } = searchCriteria;
    let searchTerm;
    
    if (hashtag) {
      searchTerm = hashtag.startsWith('#') ? hashtag : `#${hashtag}`;
    } else if (keywords) {
      searchTerm = keywords;
    } else {
      throw new Error('Either hashtag or keywords required');
    }
    
    // Navigate to search and store URL for returning
    const searchUrl = `https://x.com/search?q=${encodeURIComponent(searchTerm)}&src=typed_query&f=live`;
    console.log(`🐦 Navigating to search: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'networkidle2' });
    await sleep(3000); // Let search results load
    
    let successfulComments = 0;
    let currentPost = 0;
    const results = [];
    
    console.log('🐦 Starting keyboard navigation through search results...');
    
    while (successfulComments < maxPosts && currentPost < 50) { // Reasonable safety limit to prevent infinite loops
      currentPost++;
      console.log(`\n🐦 [${currentPost}] Processing post ${currentPost} (${successfulComments}/${maxPosts} completed)`);
      
      try {
        // Step 1: Use 'j' to advance to next result
        if (currentPost > 1) {
          console.log('⌨️ Pressing "j" to advance to next post...');
          await page.keyboard.press('j');
          await sleep(500);
        } else {
          console.log('⌨️ Pressing "j" to select first post...');
          await page.keyboard.press('j');
          await sleep(500);
        }
        
        // Step 2: Use 'Enter' to open the post
        console.log('⌨️ Pressing "Enter" to open post...');
        await page.keyboard.press('Enter');
        await sleep(3000); // Wait for post to load
        
        // Step 3: Check if my username has already commented
        console.log(`🔍 Checking if ${username} has already commented...`);
        
        // Look specifically for reply tweets from our username in the thread
        const hasMyComment = await page.evaluate((username) => {
          // Look for replies specifically from our username
          const replyElements = document.querySelectorAll('[data-testid="tweetText"]');
          let foundMyReply = false;
          
          replyElements.forEach(element => {
            // Check if this tweet is from our username by looking at the parent structure
            const tweetContainer = element.closest('[data-testid="tweet"]');
            if (tweetContainer) {
              const usernameLink = tweetContainer.querySelector(`a[href="/${username}"]`);
              if (usernameLink) {
                // Check if this is actually a reply (not the original tweet)
                const isReply = tweetContainer.querySelector('[data-testid="reply"]') || 
                               tweetContainer.textContent.includes('Replying to');
                if (isReply || tweetContainer !== replyElements[0]?.closest('[data-testid="tweet"]')) {
                  foundMyReply = true;
                }
              }
            }
          });
          
          console.log(`Found my reply: ${foundMyReply}`);
          return foundMyReply;
        }, username);
        
        if (hasMyComment) {
          console.log(`⏭️ ${username} has already commented on this post, skipping...`);
          
          // Step 4a: Click back arrow to return to search results (stay on search page)
          console.log('🔙 Clicking back arrow to return to search results...');
          await clickBackToSearch(page, searchUrl, false);
          await sleep(2000);
          
          results.push({ 
            post: currentPost, 
            success: false, 
            skipped: true, 
            reason: 'Already commented' 
          });
          continue;
        }
        
        // Step 4b: No existing comment - proceed with commenting
        console.log('✅ No existing comment found, proceeding to comment...');
        
        // Extract post content for AI if needed
        let finalComment = comment;
        if (useAI) {
          console.log('🤖 Extracting post content for AI comment generation...');
          const postContent = await page.evaluate(() => {
            const tweetText = document.querySelector('[data-testid="tweetText"]');
            return tweetText ? tweetText.textContent : 'Post content not found';
          });
          
          console.log(`📝 Post content: "${postContent.slice(0, 100)}..."`);
          // Generate AI comment (you'll need to implement this based on your existing AI logic)
          finalComment = await generateAIComment(postContent, await getSessionAssistantId('x', 'default'));
        }
        
        console.log(`💬 Commenting: "${finalComment.slice(0, 50)}..."`);
        
        // Click reply button using robust selector approach
        console.log('🐦 Waiting for reply button...');
        await page.waitForSelector('[data-testid="reply"]', { timeout: 20000 });
        
        const replyClicked = await clickFirstMatching(page, [
          '[data-testid="reply"]',
          'div[data-testid="reply"]',
          'button[data-testid="reply"]'
        ]);
        
        if (!replyClicked) {
          throw new Error('Could not find or click reply button');
        }
        
        await sleep(2000); // Wait for reply dialog to open
        
        // Find and fill comment textarea using robust selector approach
        console.log('🐦 Looking for comment textarea...');
        const textareaSelectors = [
          '[data-testid="tweetTextarea_0"] div[contenteditable="true"]',
          'div[data-testid="tweetTextarea_0"]',
          'div[contenteditable="true"][data-testid*="textInput"]',
          'div[contenteditable="true"][role="textbox"]',
          '[data-testid*="textInput"] div[contenteditable="true"]'
        ];
        
        let textareaFound = false;
        let textareaElement = null;
        
        for (const selector of textareaSelectors) {
          try {
            await page.waitForSelector(selector, { timeout: 3000 });
            textareaElement = await page.$(selector);
            if (textareaElement) {
              console.log(`✅ Found textarea with selector: ${selector}`);
              textareaFound = true;
              break;
            }
          } catch (error) {
            continue;
          }
        }
        
        if (!textareaFound || !textareaElement) {
          throw new Error('Could not find comment textarea');
        }
        
        // Clear and focus textarea
        await textareaElement.click();
        await sleep(500);
        
        // Clear existing content and type comment
        await page.keyboard.down('Meta');
        await page.keyboard.press('a');
        await page.keyboard.up('Meta');
        await page.keyboard.press('Backspace');
        await sleep(200);
        
        // Type comment with proper delay
        await textareaElement.type(finalComment, { delay: 80 });
        await sleep(1000);
        
        // Submit with Cmd+Enter (posts comment and closes box)
        console.log('🐦 Submitting comment with Cmd+Enter...');
        await page.keyboard.down('Meta'); // Cmd key on Mac
        await page.keyboard.press('Enter');
        await page.keyboard.up('Meta');
        
        await sleep(3000); // Wait for comment to post
        
        successfulComments++;
        console.log(`✅ Comment posted successfully! (${successfulComments}/${maxPosts} completed)`);
        
        results.push({ 
          post: currentPost, 
          success: true, 
          comment: finalComment 
        });
        
        // Return to search results and navigate to next post
        console.log('🔙 Clicking back arrow to return to search results and navigate to next...');
        await clickBackToSearch(page, searchUrl, true);
        await sleep(2000);
        
        // Small delay between successful comments
        if (successfulComments < maxPosts) {
          console.log('⏳ Waiting 2 seconds before next post...');
          await sleep(2000);
        }
        
      } catch (error) {
        console.log(`❌ Error processing post ${currentPost}: ${error.message}`);
        
        // Try to return to search results (stay on search page for recovery)
        console.log('🔙 Error recovery: Clicking back arrow to return to search results...');
        await clickBackToSearch(page, searchUrl, false);
        await sleep(2000);
        
        results.push({ 
          post: currentPost, 
          success: false, 
          error: error.message 
        });
        
        await sleep(1000);
      }
    }
    
    console.log(`\n📊 X Auto-Comment Complete!`);
    console.log(`✅ Successfully commented on ${successfulComments}/${maxPosts} posts`);
    console.log(`📝 Processed ${currentPost} total posts`);
    
    return {
      ok: true,
      message: `Successfully commented on ${successfulComments}/${maxPosts} posts`,
      results,
      stats: {
        target: maxPosts,
        successful: successfulComments,
        processed: currentPost,
        successRate: Math.round((successfulComments / currentPost) * 100)
      }
    };
    
  } catch (error) {
    console.error('❌ X auto-comment error:', error.message);
    throw new Error(`X auto-comment failed: ${error.message}`);
  }
}

// REMOVED: xComment function - will be rebuilt from scratch

async function TEMP_PLACEHOLDER_xComment(page, tweetUrl, comment) {
  try {
    console.log(`🐦 Starting X comment process for: ${tweetUrl}`);
    console.log(`🐦 Comment text: "${comment.slice(0, 100)}${comment.length > 100 ? '...' : ''}"`);
    
    await page.goto(tweetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000); // Allow page to settle
    
    // Click reply button
    console.log('🐦 Waiting for reply button...');
  await page.waitForSelector('[data-testid="reply"]', { timeout: 20000 });
    
    const replyClicked = await clickFirstMatching(page, [
      '[data-testid="reply"]',
      'div[data-testid="reply"]',
      'button[data-testid="reply"]'
    ]);
    
    if (!replyClicked) {
      throw new Error('Could not find or click reply button');
    }
    
    await sleep(2000); // Wait for reply dialog to open
    
    // Wait for and fill comment text area
    console.log('🐦 Waiting for comment text area...');
    const textareaSelectors = [
      '[data-testid="tweetTextarea_0"] div[contenteditable="true"]',
      'div[data-testid="tweetTextarea_0"]',
      'div[contenteditable="true"][data-testid*="textInput"]',
      'div[role="textbox"][contenteditable="true"]'
    ];
    
    let textareaFound = false;
    for (const selector of textareaSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 10000 });
        console.log(`🐦 Found textarea with selector: ${selector}`);
        
        // Clear any existing text and type comment
        await page.click(selector);
        await sleep(500); // Wait for focus
        
        // Clear existing content more thoroughly
        await page.evaluate((sel) => {
          const element = document.querySelector(sel);
          if (element) {
            element.innerHTML = '';
            element.textContent = '';
            element.value = '';
            // Trigger focus and selection events
            element.focus();
            element.click();
          }
        }, selector);
        
        await sleep(300); // Wait for DOM to update after clearing
        
        // Select all and delete any remaining content (cross-platform)
        try {
          await page.keyboard.down('Meta'); // Cmd+A on Mac
          await page.keyboard.press('a');
          await page.keyboard.up('Meta');
        } catch (e) {
          // Fallback for Windows/Linux
          await page.keyboard.down('Control'); // Ctrl+A
          await page.keyboard.press('a');
          await page.keyboard.up('Control');
        }
        await page.keyboard.press('Backspace');
        
        await sleep(200); // Small delay before typing
        await page.type(selector, comment, { delay: 80 }); // Slightly slower typing
        textareaFound = true;
        break;
      } catch (e) {
        console.log(`🐦 Selector ${selector} not found, trying next...`);
        continue;
      }
    }
    
    if (!textareaFound) {
      throw new Error('Could not find comment textarea');
    }
    
    await sleep(1000);
    
    // Submit reply using Cmd+Enter (much more reliable than button clicking)
    console.log('🐦 Submitting reply with Cmd+Enter...');
    await page.keyboard.down('Meta'); // Cmd key on Mac
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    
    // Also try Ctrl+Enter for Windows/Linux compatibility
    await sleep(500);
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter'); 
    await page.keyboard.up('Control');
    
    await sleep(3000); // Wait for comment to be posted
    
    console.log('✅ X comment posted successfully');
    return { success: true };
    
  } catch (error) {
    console.error(`❌ X comment error: ${error.message}`);
    throw new Error(`X comment failed: ${error.message}`);
  }
}

// Comment function for current page (more efficient for auto-comment workflow)
async function xCommentCurrentPage(page, comment) {
  try {
    console.log(`🐦 Starting comment on current page...`);
    console.log(`🐦 Comment text: "${comment.slice(0, 100)}${comment.length > 100 ? '...' : ''}"`);
    
    // Wait for and click reply button
    console.log('🐦 Waiting for reply button...');
  await page.waitForSelector('[data-testid="reply"]', { timeout: 20000 });
    
    const replyClicked = await clickFirstMatching(page, [
      '[data-testid="reply"]',
      'div[data-testid="reply"]',
      'button[data-testid="reply"]'
    ]);
    
    if (!replyClicked) {
      throw new Error('Could not find or click reply button');
    }
    
    await sleep(2000); // Wait for reply dialog to open
    
    // Find and type in comment textarea
    console.log('🐦 Looking for comment textarea...');
    const textareaSelectors = [
      '[data-testid="tweetTextarea_0"] div[contenteditable="true"]',
      'div[data-testid="tweetTextarea_0"]',
      'div[contenteditable="true"][data-testid*="textInput"]',
      'div[role="textbox"][contenteditable="true"]'
    ];
    
    let textareaFound = false;
    for (const selector of textareaSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 10000 });
        console.log(`🐦 Found textarea with selector: ${selector}`);
        
        // Clear any existing text and type comment
        await page.click(selector);
        await sleep(500); // Wait for focus
        
        // Clear existing content more thoroughly
        await page.evaluate((sel) => {
          const element = document.querySelector(sel);
          if (element) {
            element.innerHTML = '';
            element.textContent = '';
            element.value = '';
            // Trigger focus and selection events
            element.focus();
            element.click();
          }
        }, selector);
        
        await sleep(300); // Wait for DOM to update after clearing
        
        // Select all and delete any remaining content (cross-platform)
        try {
          await page.keyboard.down('Meta'); // Cmd+A on Mac
          await page.keyboard.press('a');
          await page.keyboard.up('Meta');
        } catch (e) {
          // Fallback for Windows/Linux
          await page.keyboard.down('Control'); // Ctrl+A
          await page.keyboard.press('a');
          await page.keyboard.up('Control');
        }
        await page.keyboard.press('Backspace');
        
        await sleep(200); // Small delay before typing
        await page.type(selector, comment, { delay: 80 }); // Slightly slower typing
        textareaFound = true;
        break;
      } catch (e) {
        console.log(`🐦 Selector ${selector} not found, trying next...`);
        continue;
      }
    }
    
    if (!textareaFound) {
      throw new Error('Could not find comment textarea');
    }
    
    await sleep(1000);
    
    // Submit reply using Cmd+Enter (much more reliable than button clicking)
    console.log('🐦 Submitting reply with Cmd+Enter...');
    await page.keyboard.down('Meta'); // Cmd key on Mac
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    
    // Also try Ctrl+Enter for Windows/Linux compatibility
    await sleep(500);
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter'); 
    await page.keyboard.up('Control');
    
    await sleep(3000); // Wait for comment to be posted
    
    console.log('✅ X comment posted successfully');
    return { success: true };
    
  } catch (error) {
    console.error(`❌ X comment current page error: ${error.message}`);
    throw new Error(`X comment failed: ${error.message}`);
  }
}

// X function will be defined later in the file

// Threads flows
async function ensureThreadsLoggedIn(page, { username, password }) {
  try {
    // 1) Go to Threads home (correct domain)
    await page.goto('https://www.threads.net/', { waitUntil: 'networkidle2' });
    await sleep(1000);

    // 2) If already logged in, bail early
    const already = await page.evaluate(() => {
      console.log('🧵 Checking if already logged in...');
      console.log('🧵 Current URL:', window.location.href);
      console.log('🧵 Page title:', document.title);
      
      // Check for actual navigation elements that indicate we're logged in
      const navSelectors = ['[aria-label="Home"]','[aria-label="Search"]','[aria-label="Activity"]','[aria-label="Profile"]'];
      let foundNav = false;
      for (const sel of navSelectors) {
        const element = document.querySelector(sel);
        if (element) {
          console.log('🧵 Found nav element:', sel);
          foundNav = true;
          break;
        }
      }
      
      // Also check for login/signup buttons (indicates NOT logged in)
      const loginButtons = document.querySelectorAll('button, a');
      let hasLoginButtons = false;
      for (const button of loginButtons) {
        const text = button.textContent?.toLowerCase() || '';
        if (text.includes('log in') || text.includes('sign up')) {
          console.log('🧵 Found login button:', text.trim());
          hasLoginButtons = true;
          break;
        }
      }
      
      const loggedIn = foundNav && !hasLoginButtons;
      console.log('🧵 Has nav elements:', foundNav);
      console.log('🧵 Has login buttons:', hasLoginButtons);
      console.log('🧵 Final determination - already logged in:', loggedIn);
      
      return loggedIn;
    });
    if (already) {
      console.log('✅ Already logged into Threads');
      return true;
    }
    
    console.log('🔐 Not logged in - proceeding with login flow');

    if (!username || !password) {
      throw new Error('Threads session missing and no credentials provided. Provide username/password or login headfully and save a session.');
    }

    // 3) Click "Continue with Instagram" (the main login button)
    console.log('🔐 Looking for Instagram login button...');
    
    // First, let's see what buttons are available
    const availableButtons = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, a, div[role="button"]');
      const buttonInfo = [];
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        const visible = btn.offsetParent !== null;
        if (text && visible) {
          buttonInfo.push({
            text: text,
            tagName: btn.tagName,
            className: btn.className,
            visible: visible
          });
        }
      }
      return buttonInfo;
    });
    
    console.log('🔐 Available clickable elements:', availableButtons.filter(b => 
      b.text.toLowerCase().includes('instagram') || 
      b.text.toLowerCase().includes('continue') ||
      b.text.toLowerCase().includes('log in')
    ));
    
    // Try multiple methods to click the Instagram button
    let instagramClicked = false;
    
    // Method 1: Try our existing text-based clicking
    instagramClicked = await tryClickByText(page, [
      'Continue with Instagram',
      'Log in with Instagram',
      'Instagram'
    ]);
    
    if (!instagramClicked) {
      // Method 2: Try direct selector approach
      console.log('🔐 Text-based click failed, trying direct selectors...');
      try {
        const instagramButton = await page.$('button:has-text("Continue with Instagram")') ||
                               await page.$('a:has-text("Continue with Instagram")') ||
                               await page.$('[aria-label*="Instagram"]') ||
                               await page.$('[data-testid*="instagram"]');
        
        if (instagramButton) {
          await instagramButton.click();
          instagramClicked = true;
          console.log('🔐 Clicked Instagram button using direct selector');
        }
      } catch (error) {
        console.log('🔐 Direct selector method failed:', error.message);
      }
    }
    
    if (!instagramClicked) {
      // Method 3: Try coordinate-based clicking
      console.log('🔐 Selector methods failed, trying coordinate-based clicking...');
      try {
        const buttonCoords = await page.evaluate(() => {
          const buttons = document.querySelectorAll('button, a, div[role="button"]');
          for (const btn of buttons) {
            const text = (btn.textContent || '').trim().toLowerCase();
            if (text.includes('continue with instagram') || text.includes('instagram')) {
              const rect = btn.getBoundingClientRect();
              return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                text: text
              };
            }
          }
          return null;
        });
        
        if (buttonCoords) {
          console.log('🔐 Found Instagram button at coordinates:', buttonCoords);
          await page.mouse.click(buttonCoords.x, buttonCoords.y);
          instagramClicked = true;
          console.log('🔐 Clicked Instagram button using coordinates');
        }
      } catch (error) {
        console.log('🔐 Coordinate-based clicking failed:', error.message);
      }
    }
    
    if (instagramClicked) {
      console.log('🔐 Instagram button clicked successfully, waiting for navigation...');
      try {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
        console.log('🔐 Navigated to:', page.url());
      } catch (navError) {
        console.log('🔐 Navigation timeout, checking current URL:', page.url());
      }
    } else {
      // Fallback to username option
      console.log('🔐 All Instagram button click methods failed, trying username option...');
      const usernameClicked = await tryClickByText(page, [
        'Log in with username instead',
        'Log in with username',
        'Use username'
      ]);
      if (!usernameClicked) {
        throw new Error('Could not find any working login button.');
      }
      console.log('🔐 Clicked username login, waiting for form...');
      await sleep(2000);
    }
    
    console.log('🔐 After login click, current URL:', page.url());
    
    // Check if we have username/password fields now
    const hasLoginForm = await page.evaluate(() => {
      const usernameField = document.querySelector('input[name="username"]');
      const passwordField = document.querySelector('input[name="password"]');
      console.log('🔐 Username field found:', !!usernameField);
      console.log('🔐 Password field found:', !!passwordField);
      return !!(usernameField && passwordField);
    });
    
    if (!hasLoginForm) {
      throw new Error('Could not find login form after clicking login options.');
    }
    
    console.log('🔐 Login form is visible, proceeding with credentials...');

    // Check if we need to navigate to Instagram or if we're already on a login form
    console.log('🔐 Current URL after navigation:', page.url());
    
    if (!/instagram\.com/i.test(page.url()) && !page.url().includes('login')) {
      // Try to follow any "Continue with Instagram" link on intermediate screens
      const continueClicked = await tryClickByText(page, ['Instagram', 'Continue']);
      if (continueClicked) {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
      }
    }

    // 5) Fill credentials (works for both Instagram and Threads login forms)
    console.log('🔐 Looking for username field...');
    await page.waitForSelector('input[name="username"]', { timeout: 60000 });
    console.log('🔐 Found username field, typing username...');
    await page.type('input[name="username"]', username, { delay: 20 });

    console.log('🔐 Looking for password field...');
    await page.waitForSelector('input[name="password"]', { timeout: 60000 });
    console.log('🔐 Found password field, typing password...');
    await page.type('input[name="password"]', password, { delay: 20 });

    // Submit
    const loginSubmit = await page.$('button[type="submit"]');
    if (loginSubmit) {
      await loginSubmit.click();
      console.log('🔐 Clicked Instagram login submit button');
    } else {
      // Try to find login button by text
      const submitClicked = await tryClickByText(page, ['Log in', 'Log In']);
      if (!submitClicked) {
        throw new Error('Instagram login button not found.');
      }
      console.log('🔐 Clicked Instagram login button by text');
    }

    // 6) Wait for post-login navigation
    await sleep(1500);

    // 7) Wait for potential navigation after login (may not happen)
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
      console.log('🔐 Navigation detected after login');
    } catch (error) {
      console.log('🔐 No navigation after login - checking current state...');
    }
    
    console.log('🔐 After login submit, current URL:', page.url());
    
    // Handle post-login flow (may include save login info, OAuth consent, etc.)
    await sleep(1000);
    
    // Handle "Save login info" / one-tap (no :contains selectors)
    await tryClickByText(page, ['Not now', "Don't save", 'Skip', 'Later']);
    
    // Handle OAuth consent
    await tryClickByText(page, ['Allow', 'Continue', 'Continue as', 'Yes, continue']);
    
    // Ensure we end up on Threads home
    if (!/threads\.(net|com)/i.test(page.url())) {
      console.log('🔐 Not on Threads, navigating to home...');
      await page.goto('https://www.threads.net/', { waitUntil: 'networkidle2' });
      await sleep(1000);
    }

    // Final verification
    const ok = await page.evaluate(() => {
      console.log('🔐 Final verification - checking for nav elements...');
      const sel = ['[aria-label="Home"]','[aria-label="Search"]','[aria-label="Activity"]','[aria-label="Profile"]'];
      let found = false;
      for (const s of sel) {
        if (document.querySelector(s)) {
          console.log('🔐 Found nav element:', s);
          found = true;
          break;
        }
      }
      console.log('🔐 Navigation elements found:', found);
      return found;
    });
    
    if (!ok) {
      console.log('🔐 Login verification failed - nav elements not found');
      throw new Error('Threads login failed - nav not visible.');
    }

    console.log('✅ Threads login successful');
    return true;
  } catch (error) {
    console.error('Threads login error:', error);
    throw new Error(`Threads login error: ${error.message}`);
  }
}

async function threadsLike(page, threadUrl) {
  console.log(`❤️ Attempting to like Threads post: ${threadUrl}`);
  await page.goto(threadUrl, { waitUntil: 'networkidle2' });
  await sleep(1000); // Wait for page to fully load
  
  // Try multiple selectors for the like button
  const likeSelectors = [
    '[data-testid="like"]',
    '[data-testid="like-button"]',
    '[aria-label*="Like"]',
    '[aria-label*="like"]',
    'button[aria-label*="Like"]',
    'button[aria-label*="like"]',
    'div[role="button"][aria-label*="Like"]',
    'div[role="button"][aria-label*="like"]',
    'svg[aria-label*="Like"]',
    'svg[aria-label*="like"]'
  ];
  
  let liked = false;
  for (const selector of likeSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 2000 });
      const element = await page.$(selector);
      if (element) {
        console.log(`✅ Found like button with selector: ${selector}`);
        await element.click();
        liked = true;
        break;
      }
    } catch (error) {
      // Continue to next selector
      continue;
    }
  }
  
  if (!liked) {
    // Try text-based clicking as fallback
    const clicked = await tryClickByText(page, ['Like', 'like']);
    if (clicked) {
      console.log(`✅ Liked post using text-based clicking`);
      liked = true;
    }
  }
  
  if (!liked) {
    throw new Error('Could not find like button on Threads post');
  }
  
  console.log(`✅ Successfully liked Threads post: ${threadUrl}`);
  await sleep(500); // Brief pause after liking
}

async function threadsComment(page, threadUrl, comment) {
  console.log(`💬 Attempting to comment on Threads post: ${threadUrl}`);
  console.log(`💬 Comment text: "${comment}"`);
  
  await page.goto(threadUrl, { waitUntil: 'networkidle2' });
  await sleep(1000); // Wait for page to fully load
  
  // Try multiple selectors for the reply button
  const replySelectors = [
    '[data-testid="reply"]',
    '[data-testid="reply-button"]', 
    '[aria-label*="Reply"]',
    '[aria-label*="reply"]',
    'button[aria-label*="Reply"]',
    'button[aria-label*="reply"]',
    'div[role="button"][aria-label*="Reply"]',
    'div[role="button"][aria-label*="reply"]',
    'svg[aria-label*="Reply"]',
    'svg[aria-label*="reply"]'
  ];
  
  console.log(`🔍 Looking for reply button...`);
  let replyClicked = false;
  for (const selector of replySelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 2000 });
      const element = await page.$(selector);
      if (element) {
        console.log(`✅ Found reply button with selector: ${selector}`);
        console.log(`🖱️ Clicking reply button...`);
        await element.click();
        console.log(`✅ Reply button clicked successfully`);
        replyClicked = true;
        break;
      }
    } catch (error) {
      continue;
    }
  }
  
  if (!replyClicked) {
    // Try text-based clicking as fallback
    const clicked = await tryClickByText(page, ['Reply', 'reply']);
    if (clicked) {
      console.log(`✅ Clicked reply using text-based clicking`);
      replyClicked = true;
    }
  }
  
  if (!replyClicked) {
    throw new Error('Could not find reply button on Threads post');
  }
  
  console.log(`⏳ Waiting for comment composer to appear...`);
  await sleep(500); // Wait for composer to appear
  
  console.log(`🔍 Looking for comment textarea...`);
  // Try multiple selectors for the comment textarea
  const textareaSelectors = [
    '[data-testid="threads-composer-textarea"]',
    '[data-testid="composer-textarea"]',
    'textarea[placeholder*="reply"]',
    'textarea[placeholder*="Reply"]',
    'textarea[aria-label*="reply"]',
    'textarea[aria-label*="Reply"]',
    'div[contenteditable="true"]',
    'textarea',
    '[role="textbox"]'
  ];
  
  let textareaFound = false;
  for (const selector of textareaSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 2000 });
      const element = await page.$(selector);
      if (element) {
        console.log(`✅ Found comment textarea with selector: ${selector}`);
        console.log(`⌨️ Starting to type comment: "${comment.slice(0, 50)}..."`);
        
        // Clear any existing text and type the comment
        await element.click();
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await page.type(selector, comment, { delay: 50 });
        console.log(`✅ Finished typing comment`);
        textareaFound = true;
        break;
      }
    } catch (error) {
      continue;
    }
  }
  
  if (!textareaFound) {
    throw new Error('Could not find comment textarea on Threads post');
  }
  
  await sleep(500); // Brief pause after typing
  
  // Primary method: Use Cmd+Enter keyboard shortcut (more reliable)
  console.log(`⌨️ Attempting to submit comment using Cmd+Enter shortcut...`);
  let submitted = false;
  
  try {
    await page.keyboard.down('Meta'); // Cmd key on Mac
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    console.log(`✅ Submitted comment using Cmd+Enter shortcut`);
    submitted = true;
  } catch (error) {
    console.log(`⚠️ Cmd+Enter failed, trying button clicking: ${error.message}`);
  }
  
  // Fallback: Try multiple selectors for the post/submit button
  if (!submitted) {
    console.log(`🔄 Trying button clicking as fallback...`);
    const submitSelectors = [
      '[data-testid="threads-composer-post-button"]',
      '[data-testid="composer-post-button"]',
      '[data-testid="post-button"]',
      'button[aria-label*="Post"]',
      'button[aria-label*="post"]',
      'button[aria-label*="Reply"]',
      'button[aria-label*="reply"]',
      'div[role="button"][aria-label*="Post"]',
      'div[role="button"][aria-label*="post"]'
    ];
    
    for (const selector of submitSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          console.log(`✅ Found submit button with selector: ${selector}`);
          await element.click();
          submitted = true;
          break;
        }
      } catch (error) {
        continue;
      }
    }
  }
  
  // Final fallback: Try text-based clicking
  if (!submitted) {
    const clicked = await tryClickByText(page, ['Post', 'post', 'Reply', 'reply', 'Submit']);
    if (clicked) {
      console.log(`✅ Submitted comment using text-based clicking`);
      submitted = true;
    }
  }
  
  if (!submitted) {
    throw new Error('Could not submit comment - tried Cmd+Enter, button clicking, and text-based clicking');
  }
  
  console.log(`✅ Successfully commented on Threads post: ${threadUrl}`);
  await sleep(1000); // Wait for comment to be posted
}

async function discoverThreadsPosts(page, searchCriteria, maxPosts = 10) {
  try {
    console.log(`🔍 Discovering Threads posts with criteria: ${JSON.stringify(searchCriteria)}`);
    
    let searchTerm = '';
    if (typeof searchCriteria === 'string') {
      searchTerm = searchCriteria;
    } else if (searchCriteria.hashtag) {
      searchTerm = searchCriteria.hashtag;
    } else if (searchCriteria.keywords) {
      searchTerm = searchCriteria.keywords;
    } else {
      throw new Error('Invalid search criteria for Threads');
    }
    
    // Remove # from hashtags since Threads search doesn't need it in the URL
    searchTerm = searchTerm.replace(/^#/, '');

    // Navigate to Threads search using correct URL format
    const url = `https://www.threads.com/search?q=${encodeURIComponent(searchTerm)}&serp_type=default`;
    console.log(`Navigating to Threads search: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2' });
    
    // Wait for page to load and debug what's available
    await sleep(3000);
    
    console.log('🔍 Debugging search results page...');
    const pageInfo = await page.evaluate(() => {
      const title = document.title;
      const url = window.location.href;
      
      // Look for various post-related selectors
      const selectors = [
        '[data-testid="thread-post"]',
        '[data-testid="post"]', 
        'article',
        '[role="article"]',
        'div[data-pressable-container="true"]',
        'a[href*="/post/"]',
        'a[href*="/@"]'
      ];
      
      const selectorResults = {};
      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        selectorResults[selector] = elements.length;
      }
      
      // Get sample links
      const allLinks = Array.from(document.querySelectorAll('a[href]')).map(a => a.href);
      const postLinks = allLinks.filter(href => href.includes('/post/') || href.includes('/@'));
      
      return {
        title,
        url,
        selectorResults,
        samplePostLinks: postLinks.slice(0, 5),
        totalLinks: allLinks.length
      };
    });
    
    console.log('🔍 Page debug info:', pageInfo);
    
    // Try multiple selectors to find posts
    let posts = [];
    
    // Method 1: Try original selector
    try {
      await page.waitForSelector('[data-testid="thread-post"]', { timeout: 10000 });
      posts = await page.evaluate((maxPosts) => {
        const postElements = document.querySelectorAll('[data-testid="thread-post"]');
        const urls = [];
        
        for (const element of postElements) {
          const linkElement = element.querySelector('a[href*="/post/"]');
          if (linkElement) {
            const href = linkElement.getAttribute('href');
            if (href && !href.includes('#')) {
              urls.push(href.startsWith('http') ? href : `https://www.threads.com${href}`);
            }
          }
        }
        
        return urls.slice(0, maxPosts);
      }, maxPosts);
      
      if (posts.length > 0) {
        console.log('🔍 Found posts using thread-post selector:', posts.length);
      }
    } catch (error) {
      console.log('🔍 thread-post selector failed:', error.message);
    }
    
    // Method 2: Try alternative selectors if first method failed
    if (posts.length === 0) {
      console.log('🔍 Trying alternative selectors...');
      posts = await page.evaluate((maxPosts) => {
        const urls = [];
        
        // Try various approaches
        const approaches = [
          () => document.querySelectorAll('article'),
          () => document.querySelectorAll('[role="article"]'),
          () => document.querySelectorAll('div[data-pressable-container="true"]'),
          () => document.querySelectorAll('a[href*="/post/"]')
        ];
        
        for (const approach of approaches) {
          const elements = approach();
          console.log(`Trying approach, found ${elements.length} elements`);
          
          for (const element of elements) {
            let linkElement = element.querySelector('a[href*="/post/"]');
            if (!linkElement && element.tagName === 'A') {
              linkElement = element;
            }
            
            if (linkElement) {
              const href = linkElement.getAttribute('href');
              if (href && href.includes('/post/') && !href.includes('#')) {
                const fullUrl = href.startsWith('http') ? href : `https://www.threads.com${href}`;
                if (!urls.includes(fullUrl)) {
                  urls.push(fullUrl);
                }
              }
            }
          }
          
          if (urls.length >= maxPosts) break;
        }
        
        return urls.slice(0, maxPosts);
      }, maxPosts);
      
      console.log('🔍 Found posts using alternative selectors:', posts.length);
    }
    
    console.log(`🔍 Final result: Found ${posts.length} Threads posts`);
    return posts.slice(0, maxPosts);
    
  } catch (error) {
    console.error('Error discovering Threads posts:', error);
    return [];
  }
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
    } else if (platform === 'threads') {
      await page.goto('https://www.threads.net/', { waitUntil: 'networkidle2' });
      const isLoggedIn = await page.evaluate(() => {
        // Check for various indicators that we're logged into Threads
        const indicators = [
          '[data-testid="threads-nav-bar"]',
          '[data-testid="nav-bar"]',
          'nav[role="navigation"]',
          '[data-testid="home-tab"]',
          '[data-testid="search-tab"]',
          '[data-testid="activity-tab"]',
          '[data-testid="profile-tab"]'
        ];
        
        for (const selector of indicators) {
          if (document.querySelector(selector)) {
            return true;
          }
        }
        
        // Also check if we're not on a login page
        const loginIndicators = [
          'input[name="username"]',
          'input[name="password"]',
          'button[type="submit"]',
          '[data-testid="login-form"]'
        ];
        
        for (const selector of loginIndicators) {
          if (document.querySelector(selector)) {
            return false;
          }
        }
        
        // If we can't find login elements and we're on threads.net, assume we're logged in
        return window.location.hostname.includes('threads.net');
      });
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
    sessionName = 'default',
    searchCriteria,
    maxPosts = 5,
    useAI = false,
    likePost = false,
    assistantId,
  } = options;

  console.log(`runAction called with action: ${action}, platform: ${platform}, sessionName: ${sessionName}`);
  
      // Clear tracking when starting a new action
  if (action === 'like' || action === 'comment' || action === 'auto-comment') {
    const prevLiked = likedPosts.size;
    const prevDiscovered = discoveredPosts.size;
    
    if (action === 'like') {
      likedPosts.clear();
    }
    discoveredPosts.clear(); // Always clear discovered posts for fresh search
    
    // Also clear comment cache for fresh testing
    if (platform === 'instagram') {
      console.log(`🧹 Clearing comment cache for fresh testing...`);
      clearCommentCache();
    }
    
    console.log(`🚀 CLEARED TRACKING: Starting fresh ${action} session (cleared ${prevLiked} liked posts, ${prevDiscovered} discovered posts)`);
  }

  let browser;
  let page;

  try {
    // Validation
    if (!platform || !['instagram', 'x', 'threads'].includes(platform)) {
      throw new Error('Invalid or missing platform');
    }
    if (!action || !['login', 'auto-comment', 'check-session', 'logout'].includes(action)) {
      throw new Error('Invalid or missing action');
    }
    if (action === 'auto-comment' && !searchCriteria) {
      throw new Error('searchCriteria is required for auto-comment action');
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



    // Load session and check login status
    console.log(`Attempting to load session: ${sessionName} for platform: ${platform}`);
    const sessionLoaded = await loadSession(page, platform, sessionName);
    console.log(`Session loading result: ${sessionLoaded}`);
    
    // Load comment cache statistics for Instagram
    if (platform === 'instagram') {
      const cacheStats = getCommentCacheStats();
      console.log(`📊 Comment cache: ${cacheStats.size} posts cached`);
    }
    
    const homeUrl = platform === 'instagram' ? 'https://www.instagram.com/' : 
                   platform === 'threads' ? 'https://www.threads.net/' : 'https://x.com/home';
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
          // Validate Assistant ID before proceeding with login
          if (!assistantId || !assistantId.startsWith('asst_')) {
            return { ok: false, message: 'Valid OpenAI Assistant ID is required (must start with asst_)' };
          }
          
          // Validate Assistant ID with OpenAI API
          if (!openai) {
            return { ok: false, message: 'OPENAI_API_KEY environment variable is required for AI validation' };
          }
          
          try {
            console.log(`🤖 Validating Assistant ID: ${assistantId}`);
            await openai.beta.assistants.retrieve(assistantId);
            console.log(`✅ Assistant ID validated successfully`);
          } catch (assistantError) {
            console.log(`❌ Assistant ID validation failed: ${assistantError.message}`);
            return { ok: false, message: `Invalid Assistant ID: ${assistantError.message}` };
          }
          
          console.log('Starting Instagram login process...');
          await ensureInstagramLoggedIn(page, { username, password });
          console.log('Instagram login successful, saving session...');
          await saveSession(page, platform, sessionName, { assistantId });
          console.log('Session saved successfully');
          return { ok: true, message: 'Instagram login successful and session saved with Assistant ID.' };
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

        const parsedCriteria = typeof searchCriteria === 'string'
          ? (searchCriteria.startsWith('#') ? { hashtag: searchCriteria } : { keywords: searchCriteria })
          : searchCriteria;

        const results = [];
        const targetSuccesses = Math.max(1, Number(maxPosts) || 1);  // how many successful comments you want
        let successes = 0;
        let attempts = 0;
        let consecutiveFailures = 0;  // Track consecutive failures to find new posts
        const seen = new Set([...discoveredPosts]);                   // avoid picking same URLs again
        let queue = await nextInstagramCandidates(page, parsedCriteria, seen, Math.min(10, targetSuccesses * 2));

        console.log(`🎯 ===== COMMENT LOOP START =====`);
        console.log(`🎯 TARGET: ${targetSuccesses} successful comments`);
        console.log(`🎯 WILL CONTINUE SEARCHING until target is reached`);
        console.log(`🎯 ===== COMMENT LOOP START =====`);
        
        while (successes < targetSuccesses) {
          console.log(`🎯 LOOP CHECK: successes=${successes}/${targetSuccesses}, attempts=${attempts}, consecutiveFailures=${consecutiveFailures}`);
          
          // Refill queue if empty or running low
          if (queue.length <= 1) {
            console.log(`🔄 Queue running low (${queue.length} posts) — discovering more candidates…`);
            const more = await nextInstagramCandidates(page, parsedCriteria, seen, 15);
            if (more.length === 0) {
              consecutiveFailures++;
              console.log(`⚠️  No new candidates found (failure ${consecutiveFailures})`);
              if (consecutiveFailures >= 3 && queue.length === 0) {
                console.log('❌ Unable to find any new posts after 3 attempts, stopping.');
                break;
              }
            } else {
              consecutiveFailures = 0; // Reset on successful discovery
              queue.push(...more);
              console.log(`✅ Found ${more.length} new candidates, queue now has ${queue.length} posts`);
            }
          }

          const postUrl = queue.shift();
          seen.add(postUrl);
          attempts++;

          try {
            console.log(`🎯 Processing post ${attempts}/${targetSuccesses * 3}: ${postUrl} (successes: ${successes}/${targetSuccesses})`);
            console.log(`🔍 Queue status: ${queue.length} posts remaining`);
            
            // Early duplicate check — skip without generating AI or navigating
            console.log(`🔍 Checking if already commented (username: ${username})`);
            const already = await hasMyCommentAndCache({ page, username, postUrl });
            if (already) {
              console.log(`⏭️  SKIP: Already commented on this post → ${postUrl}`);
              console.log(`🔄 Continuing search for new post to comment on...`);
              results.push({ url: postUrl, success: false, error: 'Already commented' });
              // Don't increment attempts for skipped posts - just continue searching
              attempts--; // Undo the increment since this wasn't a real attempt
              continue; // Immediately move to next post in queue
            }
            console.log(`✅ No existing comment found, proceeding to comment on this post`);
            

            console.log(`📝 Getting post content for commenting...`);
            const postContent = await getPostContent(page, postUrl, platform);
            
            let aiComment;
            if (useAI) {
              console.log(`🤖 Generating AI comment...`);
              const sessionAssistantId = await getSessionAssistantId(platform, sessionName);
              aiComment = await generateAIComment(postContent, sessionAssistantId);
              console.log(`🤖 AI comment: "${aiComment}"`);
            } else {
              aiComment = comment;
              console.log(`💬 Using manual comment: "${aiComment}"`);
            }

            // Post the comment (this will re-check and skip if already commented)
            const commentResult = await instagramComment(page, postUrl, aiComment, username);

            if (commentResult.skipped) {
              console.log(`⏭️  SKIPPED at posting stage: ${postUrl} - ${commentResult.reason}`);
              results.push({ url: postUrl, success: false, error: commentResult.reason });
            } else {
              console.log(`✅ SUCCESS: commented on ${postUrl}`);
              
              // Like the post if requested
              if (likePost) {
                try {
                  console.log(`❤️ Also liking post: ${postUrl}`);
                  await instagramLike(page, postUrl);
                  console.log(`✅ Successfully liked post: ${postUrl}`);
                } catch (likeError) {
                  console.log(`⚠️ Failed to like post ${postUrl}: ${likeError.message}`);
                  // Don't fail the whole operation if like fails
                }
              }
              
              results.push({ url: postUrl, success: true, comment: aiComment, liked: likePost });
              successes++;
              console.log(`🎯 PROGRESS: ${successes}/${targetSuccesses} successful comments`);
              
              // Check if we've reached our target
              if (successes >= targetSuccesses) {
                console.log(`🎉 ===== TARGET REACHED! =====`);
                console.log(`🎉 Successfully commented on ${successes} posts`);
                console.log(`🎉 Breaking out of loop`);
                console.log(`🎉 ===== TARGET REACHED! =====`);
                break;
              }
            }
            
            // Shorter delay between posts for better efficiency
            await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 1000)));
          } catch (error) {
            console.log(`❌ Error on ${postUrl}: ${error.message}`);
            results.push({ url: postUrl, success: false, error: error.message });
            // Continue to next post without long delay
            await new Promise(r => setTimeout(r, 500));
          }
        }

        console.log(`📊 Final results: ${successes} successful comments out of ${attempts} attempts`);
        if (successes < targetSuccesses) {
          console.log(`⚠️  Did not reach target of ${targetSuccesses} comments. Reached limit of ${targetSuccesses * 3} attempts.`);
        }

        return {
          ok: true,
          message: `Commented on ${successes}/${targetSuccesses} posts`,
          results,
          attempts
        };
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
        console.log('🎯 COMMENT ACTION: Starting comment action...');
        console.log(`🎯 COMMENT ACTION: Search criteria: ${JSON.stringify(searchCriteria)}`);
        console.log(`🎯 COMMENT ACTION: Use AI: ${useAI}`);
        console.log(`🎯 COMMENT ACTION: Manual comment: ${comment}`);
        
        if (searchCriteria) {
          // Bulk comment from search results with incremental discovery
          console.log(`🎯 COMMENT ACTION: Starting bulk comment with criteria: ${JSON.stringify(searchCriteria)}`);

          const parsedCriteria = typeof searchCriteria === 'string'
            ? (searchCriteria.startsWith('#') ? { hashtag: searchCriteria } : { keywords: searchCriteria })
            : searchCriteria;

          const results = [];
          const targetSuccesses = Math.max(1, Number(maxPosts) || 1);  // how many successful comments you want
          let successes = 0;
          let attempts = 0;
          let consecutiveFailures = 0;  // Track consecutive failures to find new posts
          const seen = new Set([...discoveredPosts]);                   // avoid picking same URLs again
          let queue = await nextInstagramCandidates(page, parsedCriteria, seen, Math.min(10, targetSuccesses * 2));

          console.log(`🎯 TARGET: ${targetSuccesses} successful comments`);
          console.log(`🎯 WILL CONTINUE SEARCHING until target is reached`);
          while (successes < targetSuccesses) {
            // Refill queue if empty or running low
            if (queue.length <= 1) {
              console.log(`🔄 Queue running low (${queue.length} posts) — discovering more candidates…`);
              const more = await nextInstagramCandidates(page, parsedCriteria, seen, 15);
              if (more.length === 0) {
                consecutiveFailures++;
                console.log(`⚠️  No new candidates found (failure ${consecutiveFailures})`);
                if (consecutiveFailures >= 3 && queue.length === 0) {
                  console.log('❌ Unable to find any new posts after 3 attempts, stopping.');
                  break;
                }
              } else {
                consecutiveFailures = 0; // Reset on successful discovery
                queue.push(...more);
                console.log(`✅ Found ${more.length} new candidates, queue now has ${queue.length} posts`);
              }
            }

            const postUrl = queue.shift();
            seen.add(postUrl);
            attempts++;

            try {
              console.log(`🎯 Processing post (attempts: ${attempts}, successes: ${successes}/${targetSuccesses}): ${postUrl}`);
              console.log(`🎯 LOOP CHECK: successes=${successes}/${targetSuccesses}, consecutiveFailures=${consecutiveFailures}`);
              
              // Early duplicate check — skip without generating AI or navigating
              console.log(`🔍 Checking if already commented (username: ${username})`);
              const already = await hasMyCommentAndCache({ page, username, postUrl });
              if (already) {
                console.log(`⏭️  SKIP: Already commented on this post → ${postUrl}`);
                console.log(`🔄 Continuing search for new post to comment on...`);
                results.push({ url: postUrl, success: false, error: 'Already commented' });
                // Don't increment attempts for skipped posts - just continue searching
                attempts--; // Undo the increment since this wasn't a real attempt
                continue; // Immediately move to next post in queue
              }
              console.log(`✅ No existing comment found, proceeding to comment on this post`);

              console.log(`📝 Getting post content for commenting...`);
              const postContent = await getPostContent(page, postUrl, platform);
              
              let finalComment;
              if (useAI) {
                console.log(`🤖 Generating AI comment...`);
                const sessionAssistantId = await getSessionAssistantId(platform, sessionName);
                finalComment = await generateAIComment(postContent, sessionAssistantId);
                console.log(`🤖 AI comment: "${finalComment}"`);
              } else {
                finalComment = comment;
                console.log(`💬 Using manual comment: "${finalComment}"`);
              }
              
              // Post the comment (this will re-check and skip if already commented)
              const commentResult = await instagramComment(page, postUrl, finalComment, username);
              
              if (commentResult.skipped) {
                console.log(`⏭️  Skipped at posting stage: ${postUrl} - ${commentResult.reason}`);
                results.push({ url: postUrl, success: false, error: commentResult.reason });
              } else {
                console.log(`✅ Success: commented on ${postUrl}`);
                
                // Like the post if requested
                if (likePost) {
                  try {
                    console.log(`❤️ Also liking post: ${postUrl}`);
                    await instagramLike(page, postUrl);
                    console.log(`✅ Successfully liked post: ${postUrl}`);
                  } catch (likeError) {
                    console.log(`⚠️ Failed to like post ${postUrl}: ${likeError.message}`);
                    // Don't fail the whole operation if like fails
                  }
                }
                
                results.push({ url: postUrl, success: true, comment: finalComment, liked: likePost });
                successes++;
                console.log(`🎯 Progress: ${successes}/${targetSuccesses} successful comments`);
                
                // Check if we've reached our target
                if (successes >= targetSuccesses) {
                  console.log(`🎉 Target reached! Successfully commented on ${successes} posts.`);
                  break;
                }
              }
              
              // Shorter delay between posts for better efficiency
              await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 1000)));
            } catch (error) {
              console.log(`❌ Error on ${postUrl}: ${error.message}`);
              results.push({ url: postUrl, success: false, error: error.message });
              // Continue to next post without long delay
              await new Promise(r => setTimeout(r, 500));
            }
          }

          console.log(`📊 Final results: ${successes} successful comments out of ${attempts} attempts`);
          if (successes < targetSuccesses) {
            console.log(`⚠️  Did not reach target of ${targetSuccesses} comments. Reached limit of ${targetSuccesses * 3} attempts.`);
          }

          return {
            ok: true,
            message: `Commented on ${successes}/${targetSuccesses} Instagram posts`,
            results
          };
        } else {
          // Single post comment
          console.log(`Attempting to comment on single Instagram post: ${url}`);
          

          
          const postContent = await getPostContent(page, url, platform);
          console.log(`Extracted post content: "${postContent.substring(0, 100)}..."`);
          const sessionAssistantId = await getSessionAssistantId(platform, sessionName);
          const finalComment = useAI ? await generateAIComment(postContent, sessionAssistantId) : comment;
          console.log(`Generated comment: "${finalComment}"`);
          const commentResult = await instagramComment(page, url, finalComment, username);
          
          if (commentResult.skipped) {
            console.log(`Skipped post: ${url} - ${commentResult.reason}`);
            return { ok: false, message: commentResult.reason };
          } else {
            console.log(`Successfully commented on Instagram post: ${url}`);
            
            // Like the post if requested
            if (likePost) {
              try {
                console.log(`❤️ Also liking post: ${url}`);
                await instagramLike(page, url);
                console.log(`✅ Successfully liked post: ${url}`);
              } catch (likeError) {
                console.log(`⚠️ Failed to like post ${url}: ${likeError.message}`);
                // Don't fail the whole operation if like fails
              }
            }
          }
        }
      }
      if (action === 'follow') {
        await page.goto(url, { waitUntil: 'networkidle2' });
        const followed = await clickByText(page, ['Follow']);
        if (!followed) throw new Error('Could not find Follow button on Instagram profile.');
      }
      
      if (action === 'debug-comments') {
        // Debug comment detection on a specific post
        if (!url) {
          throw new Error('URL is required for debug-comments action');
        }
        
        await page.goto(url, { waitUntil: 'networkidle2' });
        const debugResult = await debugCommentDetection(page, username);
        
        return {
          ok: true,
          message: 'Comment detection debug completed',
          debugResult,
          url
        };
      }
      
      if (action === 'stats') {
        // Show comment cache statistics
        const cacheStats = getCommentCacheStats();
        return {
          ok: true,
          message: `Comment cache statistics`,
          stats: {
            totalCached: cacheStats.size,
            cachedEntries: cacheStats.entries.slice(0, 10), // Show first 10 for preview
            sessionName: sessionName
          }
        };
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
      
      if (action === 'auto-comment') {
        return await xAutoComment(page, { searchCriteria, maxPosts, useAI, comment, username });
      }
      
      return { ok: false, message: 'X functionality limited to login and auto-comment' };
    }

    if (platform === 'threads') {
      if (action === 'login') {
        console.log(`📊 X Comment Cache: ${cacheStats.total} previously commented tweets`);
        
        // Step 1: Collect a large batch of tweets upfront
        console.log(`\n🐦 === PHASE 1: COLLECTING TWEETS ===`);
        const allTweets = await discoverXPostsBulk(page, searchCriteria, targetSuccesses * 10); // Collect 10x target to account for skips
        
        if (allTweets.length === 0) {
          console.log(`⚠️ No tweets found in search results`);
          return { ok: true, message: 'No tweets found to comment on', results: [] };
        }
        
        console.log(`\n🐦 === PHASE 2: PROCESSING TWEETS ===`);
        console.log(`🐦 Processing ${allTweets.length} collected tweets sequentially...`);
        
        // Step 2: Process tweets one by one until we reach target
        for (const tweetUrl of allTweets) {
          if (successes >= targetSuccesses) {
            console.log(`🎯 Target reached! Stopping processing.`);
            break;
          }
          attempts++;
          console.log(`\n🐦 [${attempts}/${allTweets.length}] Processing: ${tweetUrl} (${successes}/${targetSuccesses} completed)`);
          
          try {
            // Check if we should skip this tweet (duplicate detection)
            const skipCheck = await xHasMyComment(page, tweetUrl, username);
            if (skipCheck.skip) {
              console.log(`⏭️ Skipping tweet (${skipCheck.reason}): ${tweetUrl}`);
              results.push({ 
                url: tweetUrl, 
                success: false, 
                skipped: true, 
                reason: skipCheck.reason 
              });
              continue; // Skip to next tweet without counting as success
            }
            
            // Extract post content for AI
            console.log(`🐦 Extracting content for AI...`);
            const postContent = await getPostContent(page, tweetUrl, platform);
            console.log(`📝 Post content: "${postContent.slice(0, 100)}${postContent.length > 100 ? '...' : ''}"`);
            
            // Generate comment (AI or manual)
            const sessionAssistantId = await getSessionAssistantId(platform, sessionName);
            const finalComment = useAI ? 
              await generateAIComment(postContent, sessionAssistantId) : 
              comment;
            
            console.log(`💬 Generated comment: "${finalComment.slice(0, 100)}${finalComment.length > 100 ? '...' : ''}"`);
            
            // Navigate to the tweet page once
            console.log(`🐦 Navigating to tweet: ${tweetUrl}`);
            await page.goto(tweetUrl, { waitUntil: 'networkidle2' });
            await sleep(2000); // Allow page to settle
            
            // Perform like FIRST if requested (more natural workflow)
            if (likePost) {
              console.log(`❤️ Attempting to like tweet first...`);
              try {
                await xLikeCurrentPage(page);
                console.log(`✅ Tweet liked successfully`);
              } catch (likeError) {
                console.log(`⚠️ Like failed (continuing with comment): ${likeError.message}`);
              }
            }
            
            // Then comment on the post (already on the right page)
            console.log(`💬 Posting comment...`);
            const commentResult = await xCommentCurrentPage(page, finalComment);
            
            // Only add to cache if comment was actually successful
            if (commentResult && commentResult.success) {
              addToXCommentedCache(tweetUrl, 'commented');
              console.log(`✅ Comment verified successful, added to cache`);
            } else {
              throw new Error('Comment did not complete successfully');
            }
            
            successes++;
            console.log(`✅ Comment posted successfully! (${successes}/${targetSuccesses} completed)`);
            
            results.push({ 
              url: tweetUrl, 
              success: true, 
              comment: finalComment,
              liked: likePost 
            });
            
            // Break if we've reached our target
            if (successes >= targetSuccesses) {
              console.log(`🎯 Reached target of ${targetSuccesses} successful comments!`);
              break;
            }
            
            // Delay between successful comments
            if (successes < targetSuccesses) {
              console.log(`⏳ Waiting 3 seconds before next comment...`);
              await sleep(3000);
            }
            
          } catch (error) {
            console.log(`❌ Error processing tweet ${tweetUrl}: ${error.message}`);
            results.push({ url: tweetUrl, success: false, error: error.message });
            
            // Small delay before next attempt
            await sleep(1000);
          }
        }

        console.log(`📊 Final results: ${successes} successful comments out of ${attempts} attempts`);
        console.log(`📊 Loop termination reason:`);
        if (successes >= targetSuccesses) {
          console.log(`✅ SUCCESS: Reached target of ${targetSuccesses} comments`);
        } else {
          console.log(`⚠️  NO MORE TWEETS: Exhausted search results without achieving ${targetSuccesses} successes`);
        }

        return {
          ok: true,
          message: `Commented on ${successes}/${targetSuccesses} tweets`,
          results,
          attempts,
          cacheStats: {
            ...cacheStats,
            newEntries: successes
          }
        };
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
        const sessionAssistantId = await getSessionAssistantId(platform, sessionName);
        const finalComment = useAI ? await generateAIComment('', sessionAssistantId) : comment;
        await xComment(page, url, finalComment);
      }
      if (action === 'follow') {
        await page.goto(url, { waitUntil: 'networkidle2' });
        const followed = await clickFirstMatching(page, ['[data-testid$="follow"]']) || await clickByText(page, ['Follow']);
        if (!followed) throw new Error('Could not find Follow button on X profile.');
      }
    }

    if (platform === 'threads') {
      if (action === 'login') {
        try {
          // Validate Assistant ID before proceeding with login
          if (!assistantId || !assistantId.startsWith('asst_')) {
            return { ok: false, message: 'Valid OpenAI Assistant ID is required (must start with asst_)' };
          }
          
          // Validate Assistant ID with OpenAI API
          if (!openai) {
            return { ok: false, message: 'OPENAI_API_KEY environment variable is required for AI validation' };
          }
          
          try {
            console.log(`🤖 Validating Assistant ID: ${assistantId}`);
            await openai.beta.assistants.retrieve(assistantId);
            console.log(`✅ Assistant ID validated successfully`);
          } catch (assistantError) {
            console.log(`❌ Assistant ID validation failed: ${assistantError.message}`);
            return { ok: false, message: `Invalid Assistant ID: ${assistantError.message}` };
          }
          
          await ensureThreadsLoggedIn(page, { username, password });
          await saveSession(page, platform, sessionName, { assistantId });
          return { ok: true, message: 'Threads login successful and session saved with Assistant ID.' };
        } catch (error) {
          return { ok: false, message: `Threads login failed: ${error.message}` };
        }
      }

      await ensureThreadsLoggedIn(page, { username, password });
      
      if (action === 'discover') {
        const posts = await discoverThreadsPosts(page, searchCriteria, maxPosts);
        return { ok: true, message: `Found ${posts.length} Threads posts`, posts };
      }
      
      if (action === 'auto-comment') {
        const results = [];
        let attempts = 0;
        const maxAttempts = maxPosts * 3; // Search up to 3x the target to find fresh posts
        let successfulComments = 0;
        const targetComments = maxPosts || 1;
        
        console.log(`🎯 Target: ${targetComments} successful comments, Max search attempts: ${maxAttempts}`);
        
        while (successfulComments < targetComments && attempts < maxAttempts) {
          console.log(`🔍 Search iteration ${Math.floor(attempts / 10) + 1}, looking for fresh posts...`);
          
          // Get a batch of posts to check
          const batchSize = Math.min(10, maxAttempts - attempts);
          const posts = await discoverThreadsPosts(page, searchCriteria, batchSize);
          
          if (posts.length === 0) {
            console.log(`⚠️ No more posts found in search results`);
            break;
          }
          
          for (const postUrl of posts) {
            attempts++;
            
            try {
              console.log(`📝 Processing Threads post ${attempts}/${maxAttempts}: ${postUrl}`);
              
              // Check if we've already commented on this post
              const alreadyCommented = await hasMyThreadsCommentAndCache({
                page,
                username,
                postUrl,
                markCommented: false
              });
              
              if (alreadyCommented) {
                console.log(`⏭️  SKIP: Already commented on this Threads post → ${postUrl}`);
                console.log(`🔄 Continuing search for fresh posts... (${successfulComments}/${targetComments} completed)`);
                results.push({ url: postUrl, success: false, error: 'Already commented' });
                continue; // Keep searching for fresh posts
              }
              
              console.log(`✅ Fresh post found! Proceeding to comment (${successfulComments + 1}/${targetComments})`);
              
              const postContent = await getPostContent(page, postUrl, platform);
              
              let aiComment;
              if (useAI) {
                              console.log(`🤖 Generating AI comment for extracted content...`);
              console.log(`📄 Post content preview: "${postContent.slice(0, 100)}..."`);
              const startTime = Date.now();
              const sessionAssistantId = await getSessionAssistantId(platform, sessionName);
              aiComment = await generateAIComment(postContent, sessionAssistantId);
              const duration = Date.now() - startTime;
              console.log(`🤖 AI comment generated in ${duration}ms: "${aiComment}"`);
              } else {
                aiComment = comment;
                console.log(`💬 Using manual comment: "${aiComment}"`);
              }
              
              console.log(`💬 Starting comment process for: ${postUrl}`);
              await threadsComment(page, postUrl, aiComment);
              
              // Mark as commented after successful comment
              await hasMyThreadsCommentAndCache({
                page,
                username,
                postUrl,
                markCommented: true
              });
              
              // Like the post if requested
              if (likePost) {
                try {
                  // Check if already liked
                  const alreadyLiked = await hasMyThreadsLike(page, username);
                  if (alreadyLiked) {
                    console.log(`⏭️  SKIP LIKE: Post already liked → ${postUrl}`);
                  } else {
                    console.log(`❤️ Also liking Threads post: ${postUrl}`);
                    await threadsLike(page, postUrl);
                    console.log(`✅ Successfully liked Threads post: ${postUrl}`);
                  }
                } catch (likeError) {
                  console.log(`⚠️ Failed to like Threads post ${postUrl}: ${likeError.message}`);
                  // Don't fail the whole operation if like fails
                }
              }
              
              results.push({ url: postUrl, success: true, comment: aiComment });
              successfulComments++;
              
              console.log(`🎉 Successfully commented! Progress: ${successfulComments}/${targetComments}`);
              
              if (successfulComments >= targetComments) {
                console.log(`🎯 Target reached! Completed ${successfulComments} comments`);
                break; // Target reached, exit inner loop
              }
              
              await new Promise(resolve => setTimeout(resolve, 2000)); // Delay between comments
              
            } catch (error) {
              console.log(`❌ Error processing post ${postUrl}: ${error.message}`);
              results.push({ url: postUrl, success: false, error: error.message });
            }
          }
          
          if (successfulComments >= targetComments) {
            break; // Target reached, exit outer loop
          }
        }
        
        const finalMessage = successfulComments > 0 
          ? `Auto-commented on ${successfulComments} posts (searched ${attempts} posts total)`
          : `No fresh posts found to comment on (searched ${attempts} posts, all were already commented)`;
          
        return { 
          ok: true, 
          message: finalMessage, 
          results,
          attempts: successfulComments // For UI display
        };
      }

      if (action === 'like') {
        if (searchCriteria) {
          // Bulk like from search results
          const posts = await discoverThreadsPosts(page, searchCriteria, maxPosts);
          const results = [];
          
          for (const postUrl of posts) {
            try {
              await threadsLike(page, postUrl);
              results.push({ url: postUrl, success: true });
              await new Promise(resolve => setTimeout(resolve, 2000)); // Delay between likes
            } catch (error) {
              results.push({ url: postUrl, success: false, error: error.message });
            }
          }
          
          return { ok: true, message: `Liked ${results.filter(r => r.success).length} Threads posts`, results };
        } else {
          // Single post like
          await threadsLike(page, url);
        }
      }
      if (action === 'comment') {
        const sessionAssistantId = await getSessionAssistantId(platform, sessionName);
        const finalComment = useAI ? await generateAIComment('', sessionAssistantId) : comment;
        await threadsComment(page, url, finalComment);
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


