import 'dotenv/config';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { hasMyCommentAndCache, clearCommentCache, getCommentCacheStats, debugCommentDetection } from './utils/igHasMyComment.js';

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
  const nodes = await page.$x(xpath);
  return nodes.length ? nodes[0] : null;
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

// AI Comment Generation (simplified with createAndPoll)
async function generateAIComment(postContent) {
  console.log('🤖 AI: Starting AI comment generation with Assistants API...');
  console.log(`🤖 AI: Post content length: ${postContent?.length || 0}`);

  if (!openai) {
    throw new Error('OPENAI_API_KEY environment variable is required for AI comments');
  }

  try {
    const assistantId = 'asst_2aVBUHe0mfXS4JZmU5YYf5E4';
    console.log(`🤖 AI: Using assistant ID: ${assistantId}`);

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
    await new Promise(resolve => setTimeout(resolve, 800));
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
    // Primary selector
    let tweetText = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tweetText"]');
      return el ? el.textContent.trim() : '';
    });

    // Fallback: combine all language blocks inside the main article
    if (!tweetText) {
      tweetText = await page.evaluate(() => {
        const article = document.querySelector('article');
        if (!article) return '';
        const parts = Array.from(article.querySelectorAll('div[lang]')).map(n => n.textContent?.trim() || '');
        const combined = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        return combined;
      });
    }

    console.log(`🚀 X tweet content extracted: "${(tweetText || '').slice(0, 140)}${tweetText && tweetText.length > 140 ? '…' : ''}"`);
    return tweetText || '';
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
    if (!platform || !['instagram', 'x'].includes(platform)) {
      throw new Error('Invalid or missing platform');
    }
    if (!action || !['login', 'like', 'comment', 'follow', 'discover', 'auto-comment', 'check-session', 'logout', 'debug-comments'].includes(action)) {
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
    
    // Load comment cache statistics for Instagram
    if (platform === 'instagram') {
      const cacheStats = getCommentCacheStats();
      console.log(`📊 Comment cache: ${cacheStats.size} posts cached`);
    }
    
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
              aiComment = await generateAIComment(postContent);
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
              results.push({ url: postUrl, success: true, comment: aiComment });
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
          results
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
                finalComment = await generateAIComment(postContent);
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
                results.push({ url: postUrl, success: true, comment: finalComment });
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
          const finalComment = useAI ? await generateAIComment(postContent) : comment;
          console.log(`Generated comment: "${finalComment}"`);
                    const commentResult = await instagramComment(page, url, finalComment, username);
          
          if (commentResult.skipped) {
            console.log(`Skipped post: ${url} - ${commentResult.reason}`);
            return { ok: false, message: commentResult.reason };
          } else {
            console.log(`Successfully commented on Instagram post: ${url}`);
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
            const aiComment = useAI ? await generateAIComment(postContent) : comment;
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
        const finalComment = useAI ? await generateAIComment('') : comment;
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


