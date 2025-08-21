import 'dotenv/config';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { 
  ensureThreadsLoggedIn, 
  threadsLike, 
  threadsComment, 
  discoverThreadsPosts 
} from './threads-functions.js';
import { 
  ensureInstagramLoggedIn, 
  instagramLike, 
  instagramComment, 
  discoverInstagramPosts 
} from './instagram-functions.js';
import { hasMyCommentAndCache, clearCommentCache, getCommentCacheStats, debugCommentDetection } from './utils/igHasMyComment.js';
import { hasMyThreadsCommentAndCache, clearThreadsCommentCache, getThreadsCommentCacheStats, hasMyThreadsLike } from './utils/threadsHasMyComment.js';
// X cache imports removed - will be rebuilt from scratch

puppeteer.use(StealthPlugin());

// cross-runtime sleep (works in any Puppeteer version)
export const sleep = (ms) => new Promise(res => setTimeout(res, ms));

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
export async function tryClickByText(page, texts = []) {
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

// Platform-specific browser contexts for session isolation
let platformContexts = new Map(); // platform -> { context, page }

// Instagram tracking variables moved to instagram-functions.js

function getSessionFilePath(platform, sessionName) {
  const sessionsDir = path.join(__dirname, '.sessions');
  
  // If sessionName already contains platform prefix, don't double-prefix
  // Handle both formats: "platform_username" and "username"
  let cleanSessionName = sessionName;
  if (sessionName.includes('_') && sessionName.startsWith(platform + '_')) {
    cleanSessionName = sessionName.substring(platform.length + 1); // Remove "platform_"
  }
  
  return { sessionsDir, sessionPath: path.join(sessionsDir, `${platform}-${cleanSessionName}.json`) };
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

async function launchBrowser(headful, platform = null) {
  console.log(`Launching browser with headful: ${headful}${platform ? ` for platform: ${platform}` : ''}`);
  
  // For headful mode with platform isolation, check for existing platform context
  if (headful && platform && platformContexts.has(platform)) {
    try {
      const platformData = platformContexts.get(platform);
      const { context, page, wasHeadful } = platformData;
      
      // If we need headful but existing context was headless, create new context
      if (!wasHeadful && headful) {
        console.log(`🔄 Need headful mode but existing context for ${platform} was headless, creating new visible context`);
        try {
          await context.close();
        } catch (e) {
          // Context might already be closed
        }
        platformContexts.delete(platform);
        // Fall through to create new context below
      } else if (context && !context._closed && page && !page.isClosed()) {
        try {
          await page.evaluate(() => true);
          console.log(`Reusing existing ${wasHeadful ? 'headful' : 'headless'} context for ${platform}`);
          
          // Ensure page is brought to front even when reusing context
          if (headful) {
            await page.bringToFront();
            // Additional steps to ensure visibility on macOS
            await page.evaluate(() => {
              if (window.focus) window.focus();
            });
            // Force window to foreground (macOS specific)
            try {
              await page.evaluate(() => {
                if (window.chrome && window.chrome.app && window.chrome.app.window) {
                  window.chrome.app.window.current().focus();
                }
              });
            } catch (e) {
              // Chrome app API not available, that's okay
            }
            console.log('👁️ Browser window brought to front for reused context (enhanced)');
          }
          
          return { browser: globalBrowser, page };
        } catch (pageError) {
          console.log(`Existing page for ${platform} is invalid, creating new page in existing context`);
          const newPage = await context.newPage();
          await setupPage(newPage, headful);
          
          // Bring new page to front in headful mode
          if (headful) {
            await newPage.bringToFront();
            console.log('👁️ Browser window brought to front for new page in existing context');
          }
          
          platformContexts.set(platform, { context, page: newPage, wasHeadful });
          return { browser: globalBrowser, page: newPage };
        }
      } else {
        console.log(`Existing context for ${platform} is invalid, will create new one`);
        platformContexts.delete(platform);
      }
    } catch (error) {
      console.log(`Error checking existing context for ${platform}:`, error.message);
      platformContexts.delete(platform);
    }
  }
  
  // For headful mode without platform, try to reuse global browser instance
  // Try to reuse existing browser for both headful and headless operations
  if (globalBrowser) {
    try {
      // Check if the existing browser is still connected
      if (globalBrowser.isConnected()) {
        console.log('✅ Reusing existing browser instance');
        
        // For headful mode without platform, try to reuse existing page
        if (headful && !platform && globalPage) {
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
        }
        
        // For platform-specific or headless operations, use existing browser but create new page
        browser = globalBrowser;
      } else {
        console.log('Existing browser is disconnected, creating new browser');
        globalBrowser = null;
        globalPage = null;
        platformContexts.clear();
      }
    } catch (error) {
      console.log('Error checking existing browser, creating new one:', error.message);
      globalBrowser = null;
      globalPage = null;
      platformContexts.clear();
    }
  }
  
  try {
    console.log('🚀 Browser Launch Debug:');
    console.log('   headful parameter:', headful);
    console.log('   headless will be set to:', headful ? false : true);
    console.log('   (headful=true means headless=false, so browser should be visible)');
    
    // Create or reuse browser
    let browser = globalBrowser;
    if (!browser || !browser.isConnected()) {
      browser = await puppeteer.launch({
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
    
      console.log('✅ Browser launched successfully');
      console.log('   Browser process PID:', browser.process()?.pid || 'N/A');
      console.log('   Browser connected:', browser.isConnected());
    
      // Store global browser reference
    if (headful) {
      globalBrowser = browser;
      
        // Add disconnection handler to clean up references
      browser.on('disconnected', () => {
        console.log('Browser disconnected, cleaning up global references');
        globalBrowser = null;
        globalPage = null;
          platformContexts.clear();
        });
      }
    } else {
      console.log('✅ Reusing existing browser instance');
    }
    
    let page;
    
    // Platform-specific context isolation (works for both headful and headless)
    if (platform) {
      // Check if we already have a context for this platform
      if (platformContexts.has(platform)) {
        console.log(`🔄 Reusing existing context for platform: ${platform}`);
        const existingContext = platformContexts.get(platform);
        
        // Create new page in existing context
        page = await existingContext.context.newPage();
        await setupPage(page, headful);
        
        // Update the stored page reference, preserving headful state
        platformContexts.set(platform, { 
          context: existingContext.context, 
          page, 
          wasHeadful: existingContext.wasHeadful 
        });
      } else {
        console.log(`🔒 Creating new isolated context for platform: ${platform}`);
        const context = await browser.createBrowserContext();
        page = await context.newPage();
        await setupPage(page, headful);
        
        // For headful mode, bring the new page to front
        if (headful) {
          await page.bringToFront();
          console.log('👁️ Browser window brought to front for headful mode');
        }
        
        // Store platform context with headful state tracking
        platformContexts.set(platform, { context, page, wasHeadful: headful });
        console.log(`✅ Platform context created for ${platform} (${headful ? 'headful' : 'headless'})`);
      }
    } else {
      // Default behavior - create page in default context
      page = await browser.newPage();
      console.log('✅ New page created successfully');
      await setupPage(page, headful);
      
      // Store global page reference for non-platform usage
      if (headful) {
        globalPage = page;
      }
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

    // Filter: Replace em dashes (—) and en dashes (–) with commas for better social media formatting
    const filteredComment = comment.replace(/[–—]/g, ',');
    
    if (filteredComment !== comment) {
      console.log(`🔧 AI: Filtered em dashes → commas: "${filteredComment}"`);
    }
    
    console.log(`🤖 AI: Generated comment: "${filteredComment}"`);
    return filteredComment;

  } catch (error) {
    console.error('🤖 AI: OpenAI Assistants API error:', error.message);
    console.error(error.stack);
    throw new Error(`Failed to generate AI comment: ${error.message}`);
  }
}

// Instagram functions moved to instagram-functions.js

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

  if (platform === 'bluesky') {
    console.log(`🦋 Extracting Bluesky post content from: ${postUrl}`);
    
    // Try multiple selectors for Bluesky post text
    let blueskyText = await page.evaluate(() => {
      console.log('🔍 Starting Bluesky content extraction...');
      
      // Function to check if text is likely post content (not UI elements, hashtags, etc.)
      function isLikelyPostContent(text) {
        if (!text || text.length < 20) return false; // Require substantial content
        
        // Skip UI elements
        if (['Like', 'Reply', 'Repost', 'Share', 'Follow', 'Following'].some(ui => text.includes(ui))) return false;
        
        // Skip pure hashtags or short phrases
        if (text.match(/^#\w+$/)) return false; // Pure hashtag
        if (text.match(/^\d+\s*(like|reply|repost)/i)) return false; // Counter text
        
        // Must contain actual sentences (spaces and multiple words)
        if (!text.includes(' ') || text.split(' ').length < 3) return false;
        
        return true;
      }
      
      // Try specific post content selectors first
      const specificSelectors = [
        '[data-testid="post-text"]',
        '[data-testid="postText"]',
        'div[data-testid*="post"] p',
        'div[data-testid*="post"] div[dir]', // Bluesky often uses dir attribute for text
        '[role="article"] p',
        '[role="article"] div[dir]'
      ];
      
      console.log(`🔍 Trying ${specificSelectors.length} specific selectors...`);
      for (const selector of specificSelectors) {
        const elements = document.querySelectorAll(selector);
        console.log(`   Selector "${selector}": found ${elements.length} elements`);
        
        for (const element of elements) {
          const text = element.textContent?.trim();
          console.log(`   Checking text: "${text?.slice(0, 50)}..."`);
          
          if (isLikelyPostContent(text)) {
            console.log(`✅ Found quality content with selector: ${selector}`);
            return text;
          }
        }
      }
      
      // Enhanced fallback: look for the main post content more intelligently
      console.log('🔍 Trying enhanced fallback method...');
      const postContainers = document.querySelectorAll('div[data-testid*="post"], [role="article"]');
      console.log(`   Found ${postContainers.length} post containers`);
      
      for (const container of postContainers) {
        // Look for the largest text block that looks like post content
        const textElements = container.querySelectorAll('p, div, span');
        let bestCandidate = '';
        
        for (const element of textElements) {
          const text = element.textContent?.trim();
          if (text && text.length > bestCandidate.length && isLikelyPostContent(text)) {
            bestCandidate = text;
          }
        }
        
        if (bestCandidate) {
          console.log(`✅ Found content via enhanced fallback: "${bestCandidate.slice(0, 50)}..."`);
          return bestCandidate;
        }
      }
      
      console.log('❌ No substantial post content found');
      return '';
    });
    
    console.log(`🦋 Bluesky post content extracted: "${(blueskyText || '').slice(0, 140)}${blueskyText && blueskyText.length > 140 ? '…' : ''}"`);
    return blueskyText || '';
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
          if (text.length < 15) continue; // Increased minimum to avoid usernames
          if (text.match(/^@\w+$/)) continue; // Skip usernames like @username
          if (text.match(/^[A-Za-z0-9_]+$/)) continue; // Skip single usernames without @
          if (text.match(/^\d+[smhd]$/)) continue; // Skip timestamps like 2h, 5m
          if (text.match(/^(Like|Reply|Share|Follow|•|\d+$)$/i)) continue; // Skip UI buttons
          if (text.includes('Suggested for you')) continue;
          if (text.includes('View profile')) continue;
          if (text.includes('Follow')) continue;
          if (text.includes('@') && !text.includes(' ')) continue; // Skip standalone mentions
          if (text.startsWith('@') && text.length < 30) continue; // Skip short mentions
          if (text.includes('Verified')) continue;
          if (!text.includes(' ')) continue; // Ensure it's a sentence, not a single word
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
            // More strict filtering to avoid usernames
            if (text.length < 20) return false; // Increased minimum length
            if (text.length > 2000) return false; // Maximum reasonable length
            if (isButton) return false; // Skip button elements
            if (text.match(/^@\w+$/)) return false; // Skip standalone usernames
            if (text.match(/^[A-Za-z0-9_]+$/)) return false; // Skip single usernames without @
            if (text.match(/^\d+[smhd]$/)) return false; // Skip timestamps
            if (text.match(/^(Like|Reply|Share|Follow|•|\d+$|View profile|Suggested for you|More|Show)$/i)) return false;
            if (text.includes('threads.net')) return false;
            if (text.includes('@threads')) return false;
            if (text.includes('Verified')) return false;
            if (text.includes('Follow') && text.length < 50) return false; // Skip short Follow texts
            if (text.includes('@') && !text.includes(' ')) return false; // Skip standalone mentions
            if (text.startsWith('@') && text.length < 40) return false; // Skip short mentions
            if (!text.includes(' ')) return false; // Ensure it's a sentence, not a single word
            
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

// Instagram login function moved to instagram-functions.js

// Instagram like function moved to instagram-functions.js

// Instagram comment function moved to instagram-functions.js

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
    
    console.log(`\n🎯 ACTION: Auto-commenting on X (Twitter)`);
    console.log(`👤 ACCOUNT: ${username}`);
    console.log(`🔍 SEARCH: ${searchTerm} (Target: ${maxPosts} comments)`);
    
    await page.goto(searchUrl, { waitUntil: 'networkidle2' });
    await sleep(3000); // Let search results load
    
    // Check if there are any posts on the search page
    const hasResults = await page.evaluate(() => {
      const posts = document.querySelectorAll('[data-testid="tweet"]');
      return posts.length > 0;
    });
    
    if (!hasResults) {
      console.log(`❌ No posts found for search term: ${searchTerm}`);
      return { ok: true, message: `No posts found for "${searchTerm}" on X` };
    }
    
    console.log(`✅ Found posts on X search page, starting navigation`);
    
    let successfulComments = 0;
    let currentPost = 0;
    const results = [];
    
    while (successfulComments < maxPosts && currentPost < 50) { // Reasonable safety limit to prevent infinite loops
      currentPost++;
      
      try {
        // Navigate to next post
        if (currentPost > 1) {
          await page.keyboard.press('j');
          await sleep(500);
        } else {
          await page.keyboard.press('j');
          await sleep(500);
        }
        
        // Open the post
        await page.keyboard.press('Enter');
        await sleep(3000); // Wait for post to load
        
        // Extract post content first
        const postContent = await page.evaluate(() => {
          const tweetText = document.querySelector('[data-testid="tweetText"]');
          return tweetText ? tweetText.textContent.trim() : 'Post content not found';
        });
        
        console.log(`\n📄 POST ${currentPost}: "${postContent.slice(0, 80)}${postContent.length > 80 ? '...' : ''}"`);
        
        // Filter 1: Check text length (must be at least 5 words)
        const wordCount = postContent.trim().split(/\s+/).filter(word => word.length > 0).length;
        if (wordCount < 5) {
          console.log(`⏭️  SKIP: Post too short (${wordCount} words, need 5+)`);
          await clickBackToSearch(page, searchUrl, false);
          await sleep(2000);
          
          results.push({ 
            post: currentPost, 
            success: false, 
            skipped: true, 
            reason: `Post too short (${wordCount} words)` 
          });
          currentPost++;
          continue;
        }
        console.log(`✅ TEXT LENGTH: ${wordCount} words (sufficient)`);
        
        // Filter 2: Check for video content
        const hasVideo = await page.evaluate(() => {
          // Look for video elements in X/Twitter
          const videoSelectors = [
            'video',
            '[data-testid="videoPlayer"]',
            '[data-testid="videoComponent"]',
            '[aria-label*="video" i]',
            'div[role="button"][aria-label*="play" i]',
            '[data-testid="playButton"]'
          ];
          
          for (const selector of videoSelectors) {
            if (document.querySelector(selector)) {
              return true;
            }
          }
          
          // Check for video-related indicators in tweet
          const tweetText = document.body.textContent.toLowerCase();
          if (tweetText.includes('video') && (tweetText.includes('play') || tweetText.includes('watch'))) {
            return true;
          }
          
          return false;
        });
        
        if (hasVideo) {
          console.log(`⏭️  SKIP: Post contains video content`);
          await clickBackToSearch(page, searchUrl, false);
          await sleep(2000);
          
          results.push({ 
            post: currentPost, 
            success: false, 
            skipped: true, 
            reason: 'Post contains video' 
          });
          currentPost++;
          continue;
        }
        console.log(`✅ VIDEO CHECK: No video content detected`);
        
        // Filter 3: Check if already commented
        
        // Check for existing comments
        const hasMyComment = await page.evaluate((username) => {
          const replyElements = document.querySelectorAll('[data-testid="tweetText"]');
          let foundMyReply = false;
          
          replyElements.forEach(element => {
            const tweetContainer = element.closest('[data-testid="tweet"]');
            if (tweetContainer) {
              const usernameLink = tweetContainer.querySelector(`a[href="/${username}"]`);
              if (usernameLink) {
                const isReply = tweetContainer.querySelector('[data-testid="reply"]') || 
                               tweetContainer.textContent.includes('Replying to');
                if (isReply || tweetContainer !== replyElements[0]?.closest('[data-testid="tweet"]')) {
                  foundMyReply = true;
                }
              }
            }
          });
          
          return foundMyReply;
        }, username);
        
        if (hasMyComment) {
          console.log(`🔄 DUPLICATE CHECK: Already commented → SKIPPING`);
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
        
        console.log(`✅ DUPLICATE CHECK: No existing comment → PROCEEDING`);
        
        // Generate comment
        let finalComment = comment;
        if (useAI) {
          finalComment = await generateAIComment(postContent, await getSessionAssistantId('x', 'default'));
          console.log(`🤖 AI COMMENT: "${finalComment}"`);
        } else {
          console.log(`💬 MANUAL COMMENT: "${finalComment}"`);
        }
        
        // Click reply button
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
        
        // Find comment textarea
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
        
        // Clear and type comment
        await textareaElement.click();
        await sleep(500);
        await page.keyboard.down('Meta');
        await page.keyboard.press('a');
        await page.keyboard.up('Meta');
        await page.keyboard.press('Backspace');
        await sleep(200);
        await textareaElement.type(finalComment, { delay: 80 });
        await sleep(1000);
        
        // Submit comment
        await page.keyboard.down('Meta');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Meta');
        await sleep(3000);
        
        successfulComments++;
        console.log(`✅ COMPLETED: Comment posted successfully (${successfulComments}/${maxPosts})`);
        
        results.push({ 
          post: currentPost, 
          success: true, 
          comment: finalComment 
        });
        
        // Return to search results
        await clickBackToSearch(page, searchUrl, true);
        await sleep(2000);
        
        // Small delay between successful comments
        if (successfulComments < maxPosts) {
          console.log('⏳ Waiting 2 seconds before next post...');
          await sleep(2000);
        }
        
      } catch (error) {
        console.log(`❌ ERROR: ${error.message}`);
        
        // Try to return to search results
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
    
    console.log(`\n🎉 FINAL RESULTS: ${successfulComments}/${maxPosts} comments posted`);
    
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
// ensureThreadsLoggedIn function moved to threads-functions.js

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
    } else if (platform === 'bluesky') {
      await page.goto('https://bsky.app/', { waitUntil: 'networkidle2' });
      const isLoggedIn = await page.evaluate(() => {
        // Check for various indicators that we're logged into Bluesky
        const composeButton = document.querySelector('[aria-label*="Compose"]') || 
                             document.querySelector('[data-testid*="compose"]') ||
                             document.querySelector('button[aria-label*="Write a post"]');
        const userMenu = document.querySelector('[aria-label*="Profile"]') || 
                        document.querySelector('[data-testid*="profile"]');
        const feedIndicator = document.querySelector('[aria-label*="Timeline"]') ||
                             document.querySelector('[data-testid*="feed"]');
        
        return !!(composeButton || userMenu || feedIndicator);
      });
      return { loggedIn: isLoggedIn };
    } else if (platform === 'threads') {
      await page.goto('https://www.threads.net/', { waitUntil: 'networkidle2' });
      const loginCheckResult = await page.evaluate(() => {
        const debugLog = [];
        const currentUrl = window.location.href;
        debugLog.push(`Threads status check on URL: ${currentUrl}`);
        
        // Check for logged-in indicators (more comprehensive)
        const loginIndicators = [
          // Navigation elements
          'nav[role="navigation"]',
          '[role="main"]',
          'main',
          // Compose/posting elements
          '[aria-label*="Compose"]',
          '[aria-label*="Write"]',
          '[aria-label*="Create"]',
          'button[aria-label*="Compose"]',
          'textarea[placeholder*="Start a thread"]',
          'textarea[placeholder*="What\'s new"]',
          // User/profile elements
          '[aria-label*="Profile"]',
          '[data-testid*="user"]',
          'img[alt*="profile"]',
          // Feed/content elements
          '[data-testid*="post"]',
          '[data-testid*="thread"]',
          'article',
          // Home/timeline indicators
          '[aria-label*="Home"]',
          '[aria-label*="Timeline"]',
          '[aria-label*="Feed"]'
        ];
        
        const foundIndicators = [];
        for (const selector of loginIndicators) {
          const element = document.querySelector(selector);
          if (element) {
            foundIndicators.push(selector);
          }
        }
        debugLog.push(`Found login indicators: ${foundIndicators.join(', ')}`);
        
        // Check for login form elements (indicates NOT logged in)
        const loginFormElements = [
          'input[name="username"]',
          'input[name="password"]',
          'input[placeholder*="Username"]',
          'input[placeholder*="Phone number"]',
          'button[type="submit"]',
          '[data-testid="login-form"]',
          'form[method="post"]'
        ];
        
        const foundLoginElements = [];
        for (const selector of loginFormElements) {
          const element = document.querySelector(selector);
          if (element) {
            foundLoginElements.push(selector);
          }
        }
        debugLog.push(`Found login form elements: ${foundLoginElements.join(', ')}`);
        
        // Check page title
        const pageTitle = document.title;
        debugLog.push(`Page title: ${pageTitle}`);
        
        const titleIndicatesLogin = pageTitle.includes('Login') || pageTitle.includes('Sign in');
        if (titleIndicatesLogin) {
          debugLog.push('Page title indicates login page');
        }
        
        // Determine login status
        const hasLoginIndicators = foundIndicators.length > 0;
        const hasLoginForm = foundLoginElements.length > 0;
        const onThreadsDomain = currentUrl.includes('threads.net') || currentUrl.includes('threads.com');
        
        // We're logged in if we have indicators AND no login form AND on threads domain
        const isLoggedIn = hasLoginIndicators && !hasLoginForm && onThreadsDomain && !titleIndicatesLogin;
        
        debugLog.push(`Threads login determination:`);
        debugLog.push(`  - Has login indicators: ${hasLoginIndicators} (${foundIndicators.length})`);
        debugLog.push(`  - Has login form: ${hasLoginForm}`);
        debugLog.push(`  - On threads domain: ${onThreadsDomain}`);
        debugLog.push(`  - Title indicates login: ${titleIndicatesLogin}`);
        debugLog.push(`  - Final result: ${isLoggedIn}`);
        
        return { isLoggedIn, debugLog, foundIndicators, foundLoginElements };
      });
      
      // Log debug information
      console.log('=== Threads Session Status Check ===');
      loginCheckResult.debugLog.forEach(log => console.log(log));
      console.log('====================================');
      
      return { loggedIn: loginCheckResult.isLoggedIn };
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
  
      // Clear tracking when starting a new action
  if (action === 'like' || action === 'comment' || action === 'auto-comment') {
    // Note: Instagram tracking variables are now handled within instagram-functions.js
    
    // Also clear comment cache for fresh testing
    if (platform === 'instagram') {
      clearCommentCache();
    }
  }

  let browser;
  let page;

  try {
    // Validation
    if (!platform || !['instagram', 'x', 'threads', 'bluesky'].includes(platform)) {
      throw new Error('Invalid or missing platform');
    }
    if (!action || !['login', 'auto-comment', 'check-session', 'logout'].includes(action)) {
      throw new Error('Invalid or missing action');
    }
    if (action === 'auto-comment' && !searchCriteria) {
      throw new Error('searchCriteria is required for auto-comment action');
    }

    // Launch browser with platform isolation for headful mode
    const browserResult = await launchBrowser(headful, platform);
    browser = browserResult.browser;
    page = browserResult.page;

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
      
      // Load session first
      const sessionLoaded = await loadSession(page, platform, sessionName);
      
      // Use the same login detection logic as other actions
      if (platform === 'bluesky') {
        await page.goto('https://bsky.app/', { waitUntil: 'networkidle2' });
        
        const loginStatus = await page.evaluate(() => {
          const composeButton = document.querySelector('[aria-label*="Compose"], [data-testid*="compose"], button[aria-label*="compose" i]');
          const userMenu = document.querySelector('[aria-label*="Account"], [data-testid*="account"], [data-testid*="user"]');
          const feedIndicator = document.querySelector('[data-testid*="feed"], .feed, [aria-label*="feed"]');
          const homeIndicator = document.querySelector('[aria-label*="Home"], [data-testid*="home"]');
          
          const debugInfo = {
            url: window.location.href,
            title: document.title,
            cookies: document.cookie,
            localStorageKeys: Object.keys(localStorage),
            sessionStorageKeys: Object.keys(sessionStorage),
            foundElements: {
              composeButton: !!composeButton,
              userMenu: !!userMenu,
              feedIndicator: !!feedIndicator,
              homeIndicator: !!homeIndicator
            }
          };
          
          // Check localStorage for logged-out indicators
          const loggedOutIndicators = debugInfo.localStorageKeys.filter(key => 
            key.includes('logged-out') || key.includes('anonymous')
          );
          
          // Check for positive login indicators in localStorage
          const loggedInIndicators = debugInfo.localStorageKeys.filter(key => 
            key.includes('did:plc:') || key.includes('BSKY_STORAGE') || key.includes('agent-labelers')
          );
          
          // Strong login detection: UI elements OR localStorage indicators override stale logged-out keys
          const hasUIIndicators = !!(composeButton || userMenu);
          const hasStorageIndicators = loggedInIndicators.length > 0;
          const isLoggedIn = hasUIIndicators || hasStorageIndicators;
          
          debugInfo.isLoggedIn = isLoggedIn;
          debugInfo.loggedOutIndicators = loggedOutIndicators;
          debugInfo.loggedInIndicators = loggedInIndicators;
          debugInfo.hasUIIndicators = hasUIIndicators;
          debugInfo.hasStorageIndicators = hasStorageIndicators;
          
          return debugInfo;
        });
        
        console.log('🔍 Bluesky Login Status Debug:', JSON.stringify(loginStatus, null, 2));
        
        if (loginStatus.isLoggedIn) {
          // Additional test: Check if search functionality works (tests token validity)
          console.log('🔍 Testing Bluesky search functionality to verify token validity...');
          try {
            await page.goto('https://bsky.app/search?q=test', { waitUntil: 'networkidle2' });
            await sleep(2000);
            
            const searchTest = await page.evaluate(() => {
              const pageText = document.body.textContent;
              const searchUnavailable = pageText.includes('Search is currently unavailable when logged out');
              const hasSearchResults = document.querySelectorAll('a[href*="/post/"]').length > 0;
              
              return {
                searchUnavailable,
                hasSearchResults,
                pageText: pageText.substring(0, 200) // First 200 chars for debugging
              };
            });
            
            if (searchTest.searchUnavailable) {
              console.log('⚠️ Search functionality unavailable - token likely expired');
              return { 
                ok: true, 
                message: 'Logged in but token expired - please re-login', 
                loggedIn: false, 
                platform, 
                sessionName,
                reason: 'Search token expired'
              };
            } else {
              console.log('✅ Search functionality working - full authentication confirmed');
              return { ok: true, message: 'Logged in', loggedIn: true, platform, sessionName };
            }
          } catch (searchError) {
            console.log('⚠️ Search test failed:', searchError.message);
            return { 
              ok: true, 
              message: 'Logged in but search failed', 
              loggedIn: false, 
              platform, 
              sessionName,
              reason: 'Search functionality failed'
            };
          }
        } else {
          const uiStatus = loginStatus.hasUIIndicators ? '✅ UI elements present' : '❌ Missing UI elements';
          const storageStatus = loginStatus.hasStorageIndicators ? '✅ Auth data present' : '❌ No auth data';
          const reason = `${uiStatus}, ${storageStatus}`;
          console.log(`❌ Bluesky session is invalid - user is logged out. Status: ${reason}`);
          return { ok: true, message: 'Logged out', loggedIn: false, platform, sessionName, reason };
        }
      } else {
        // For other platforms, implement similar logic or return basic status
        console.log(`ℹ️ Status check for ${platform} - session loaded: ${sessionLoaded}`);
        return { ok: true, message: sessionLoaded ? 'Session loaded' : 'No session', loggedIn: sessionLoaded, platform, sessionName };
      }
    }



    // Load session and check login status
    const sessionLoaded = await loadSession(page, platform, sessionName);
    
    // Load comment cache statistics for Instagram
    if (platform === 'instagram') {
      const cacheStats = getCommentCacheStats();
      console.log(`📊 Comment cache: ${cacheStats.size} posts cached`);
    }
    
    const homeUrl = platform === 'instagram' ? 'https://www.instagram.com/' : 
                   platform === 'threads' ? 'https://www.threads.net/' : 
                   platform === 'bluesky' ? 'https://bsky.app/' : 'https://x.com/home';
    console.log(`Navigating to: ${homeUrl}`);
    await page.goto(homeUrl, { waitUntil: 'networkidle2' });
    
    // Reload session after navigation to ensure localStorage can be set properly
    if (sessionLoaded) {
      console.log('🔄 Reloading session after page navigation to ensure localStorage works...');
      await loadSession(page, platform, sessionName);
    }
    
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
        const parsedCriteria = typeof searchCriteria === 'string'
          ? (searchCriteria.startsWith('#') ? { hashtag: searchCriteria } : { keywords: searchCriteria })
          : searchCriteria;

        console.log(`\n🎯 ACTION: Auto-commenting on Instagram`);
        console.log(`👤 ACCOUNT: ${username}`);
        console.log(`🔍 SEARCH: ${JSON.stringify(parsedCriteria)} (Target: ${maxPosts} comments)`);

        const results = [];
        const targetSuccesses = Math.max(1, Number(maxPosts) || 1);
        let successes = 0;
        let attempts = 0;
        let consecutiveFailures = 0;
        const seen = new Set(); // Instagram discovery tracking now handled in instagram-functions.js
        let queue = await discoverInstagramPosts(page, parsedCriteria, Math.min(10, targetSuccesses * 2));
        
        while (successes < targetSuccesses) {
          // Refill queue if empty or running low
          if (queue.length <= 1) {
            const more = await discoverInstagramPosts(page, parsedCriteria, 15);
            if (more.length === 0) {
              consecutiveFailures++;
              if (consecutiveFailures >= 3 && queue.length === 0) {
                break;
              }
            } else {
              consecutiveFailures = 0;
              queue.push(...more);
            }
          }

          const postUrl = queue.shift();
          seen.add(postUrl);
          attempts++;

          try {
            // Get post content for display
            const postContent = await getPostContent(page, postUrl, platform);
            console.log(`\n📄 POST ${attempts}: "${postContent.slice(0, 80)}${postContent.length > 80 ? '...' : ''}"`);
            
            // Check for duplicates
            const already = await hasMyCommentAndCache({ page, username, postUrl });
            if (already) {
              console.log(`🔄 DUPLICATE CHECK: Already commented → SKIPPING`);
              results.push({ url: postUrl, success: false, error: 'Already commented' });
              attempts--;
              continue;
            }
            console.log(`✅ DUPLICATE CHECK: No existing comment → PROCEEDING`);
            
            // Generate comment
            let aiComment;
            if (useAI) {
              const sessionAssistantId = await getSessionAssistantId(platform, sessionName);
              aiComment = await generateAIComment(postContent, sessionAssistantId);
              console.log(`🤖 AI COMMENT: "${aiComment}"`);
            } else {
              aiComment = comment;
              console.log(`💬 MANUAL COMMENT: "${aiComment}"`);
            }

            // Post the comment (this will re-check and skip if already commented)
            const commentResult = await instagramComment(page, postUrl, aiComment, username);

            if (commentResult.skipped) {
              console.log(`⏭️ SKIPPED: ${commentResult.reason}`);
              results.push({ url: postUrl, success: false, error: commentResult.reason });
            } else {
              // Like the post if requested
              if (likePost) {
                try {
                  console.log(`❤️ Liking post: ${postUrl}`);
                  const likeResult = await instagramLike(page, postUrl);
                  if (likeResult) {
                    console.log(`✅ Post liked successfully`);
                  } else {
                    console.log(`⚠️ Like may have failed (returned false)`);
                  }
                } catch (likeError) {
                  console.log(`❌ Like failed: ${likeError.message}`);
                  // Don't fail the whole operation if like fails, but show the error
                }
              }
              
              results.push({ url: postUrl, success: true, comment: aiComment, liked: likePost });
              successes++;
              console.log(`✅ COMPLETED: Comment posted successfully (${successes}/${targetSuccesses})`);
              
              // Check if we've reached our target
              if (successes >= targetSuccesses) {
                break;
              }
            }
            
            // Shorter delay between posts for better efficiency
            await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 1000)));
          } catch (error) {
            console.log(`❌ ERROR: ${error.message}`);
            results.push({ url: postUrl, success: false, error: error.message });
            await new Promise(r => setTimeout(r, 500));
          }
        }

        console.log(`\n🎉 FINAL RESULTS: ${successes}/${targetSuccesses} comments posted`);

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
          const seen = new Set(); // Instagram discovery tracking now handled in instagram-functions.js
          let queue = await discoverInstagramPosts(page, parsedCriteria, Math.min(10, targetSuccesses * 2));

          console.log(`🎯 TARGET: ${targetSuccesses} successful comments`);
          console.log(`🎯 WILL CONTINUE SEARCHING until target is reached`);
          while (successes < targetSuccesses) {
            // Refill queue if empty or running low
            if (queue.length <= 1) {
              console.log(`🔄 Queue running low (${queue.length} posts) — discovering more candidates…`);
              const more = await discoverInstagramPosts(page, parsedCriteria, 15);
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
              
              // Get post content for filtering
              const postContent = await getPostContent(page, postUrl, platform);
              console.log(`📄 POST CONTENT: "${postContent.slice(0, 80)}${postContent.length > 80 ? '...' : ''}"`);
              
              // Filter 1: Check text length (must be at least 5 words)
              const wordCount = postContent.trim().split(/\s+/).filter(word => word.length > 0).length;
              if (wordCount < 5) {
                console.log(`⏭️  SKIP: Post too short (${wordCount} words, need 5+) → ${postUrl}`);
                results.push({ url: postUrl, success: false, error: `Post too short (${wordCount} words)` });
                attempts--; // Don't count as real attempt
                continue;
              }
              console.log(`✅ TEXT LENGTH: ${wordCount} words (sufficient)`);
              
              // Filter 2: Check for video content
              await page.goto(postUrl, { waitUntil: 'networkidle2' });
              await sleep(2000);
              
              const hasVideo = await page.evaluate(() => {
                // Look for video elements
                const videoSelectors = [
                  'video',
                  '[aria-label*="video" i]',
                  '[aria-label*="reel" i]',
                  'div[role="button"][aria-label*="play" i]',
                  '.video-player',
                  '[data-testid*="video"]'
                ];
                
                for (const selector of videoSelectors) {
                  if (document.querySelector(selector)) {
                    return true;
                  }
                }
                
                // Check for video-related text indicators
                const pageText = document.body.textContent.toLowerCase();
                if (pageText.includes('watch') || pageText.includes('play video') || pageText.includes('video player')) {
                  return true;
                }
                
                return false;
              });
              
              if (hasVideo) {
                console.log(`⏭️  SKIP: Post contains video content → ${postUrl}`);
                results.push({ url: postUrl, success: false, error: 'Post contains video' });
                attempts--; // Don't count as real attempt
                continue;
              }
              console.log(`✅ VIDEO CHECK: No video content detected`);

              // Filter 3: Early duplicate check — skip without generating AI
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
        console.log(`\n🎯 ACTION: Auto-commenting on Threads`);
        console.log(`👤 ACCOUNT: ${username}`);
        console.log(`🔍 SEARCH: #${searchCriteria.hashtag || searchCriteria.keywords} (Target: ${maxPosts} comments)`);
        
        const results = [];
        let attempts = 0;
        const maxAttempts = maxPosts * 3;
        let successfulComments = 0;
        const targetComments = maxPosts || 1;
        
        while (successfulComments < targetComments && attempts < maxAttempts) {
          // Get a batch of posts to check
          const batchSize = Math.min(10, maxAttempts - attempts);
          const posts = await discoverThreadsPosts(page, searchCriteria, batchSize);
          
          if (posts.length === 0) {
            break;
          }
          
          for (const postUrl of posts) {
          attempts++;
            
            try {
              // Get post content for filtering
              const threadsPostContent = await getPostContent(page, postUrl, platform);
              console.log(`📄 POST CONTENT: "${threadsPostContent.slice(0, 80)}${threadsPostContent.length > 80 ? '...' : ''}"`);
              
              // Filter 1: Check text length (must be at least 5 words)
              const wordCount = threadsPostContent.trim().split(/\s+/).filter(word => word.length > 0).length;
              if (wordCount < 5) {
                console.log(`⏭️  SKIP: Post too short (${wordCount} words, need 5+) → ${postUrl}`);
                results.push({ url: postUrl, success: false, error: `Post too short (${wordCount} words)` });
                continue;
              }
              console.log(`✅ TEXT LENGTH: ${wordCount} words (sufficient)`);
              
              // Filter 2: Check for video content
              await page.goto(postUrl, { waitUntil: 'networkidle2' });
              await sleep(2000);
              
              const videoCheck = await page.evaluate(() => {
                // Look for video elements in Threads
                const videoSelectors = [
                  'video',
                  '[aria-label*="video" i]',
                  '[role="button"][aria-label*="play" i]',
                  'div[data-pressable-container="true"][aria-label*="play" i]',
                  '.video-player'
                ];
                
                let foundSelector = null;
                for (const selector of videoSelectors) {
                  if (document.querySelector(selector)) {
                    foundSelector = selector;
                    break;
                  }
                }
                
                // Check for video indicators in Threads (more specific)
                // Look for actual video controls, not just text mentioning video
                const videoControls = document.querySelector('[aria-label*="play video" i]') ||
                                    document.querySelector('[aria-label*="video player" i]') ||
                                    document.querySelector('[data-testid*="video"]') ||
                                    document.querySelector('.video-controls');
                
                return {
                  hasVideo: !!(foundSelector || videoControls),
                  foundSelector,
                  hasVideoControls: !!videoControls
                };
              });
              
              if (videoCheck.hasVideo) {
                console.log(`⏭️  SKIP: Post contains video content (${videoCheck.foundSelector || 'video controls'}) → ${postUrl}`);
                results.push({ url: postUrl, success: false, error: 'Post contains video' });
                continue;
              }
              console.log(`✅ VIDEO CHECK: No video content detected`);

              // Filter 3: Check if we've already commented on this post
              const alreadyCommented = await hasMyThreadsCommentAndCache({
                page,
                username,
                postUrl,
                markCommented: false
              });
              
              if (alreadyCommented) {
                console.log(`🔄 DUPLICATE CHECK: Already commented → SKIPPING`);
                results.push({ url: postUrl, success: false, error: 'Already commented' });
                continue;
              }
              
              console.log(`✅ DUPLICATE CHECK: No existing comment → PROCEEDING`);
              
              // Load post and extract content
              await page.goto(postUrl, { waitUntil: 'networkidle2' });
              await sleep(1000);
              
              // Extract the actual post content
              const actualPostContent = await page.evaluate(() => {
                // Find the main post content by looking for the largest text block that isn't a username
                const allElements = document.querySelectorAll('div[dir="auto"], span');
                const candidates = [];
                
                for (const element of allElements) {
                  const text = element.textContent?.trim();
                  if (!text || text.length < 20) continue;
                  
                  // Skip if it's clearly UI or username
                  if (text.match(/^@\w+$/)) continue; // Skip @username
                  if (text.match(/^[A-Za-z0-9_]+$/)) continue; // Skip plain usernames
                  if (text === 'Follow') continue;
                  if (text === 'Reply') continue;
                  if (text === 'Like') continue;
                  if (text === 'Share') continue;
                  if (text.includes('Verified')) continue;
                  if (text.match(/^\d+[smh]$/)) continue; // Skip timestamps
                  
                  // Must contain spaces (be a sentence)
                  if (!text.includes(' ')) continue;
                  
                  candidates.push({
                    text: text,
                    length: text.length,
                    hasHashtags: /#\w+/.test(text),
                    hasEmojis: /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u.test(text)
                  });
                }
                
                if (candidates.length === 0) {
                  return 'No post content found';
                }
                
                // Sort by likely post content (longer text, has hashtags/emojis)
                candidates.sort((a, b) => {
                  let scoreA = a.length;
                  let scoreB = b.length;
                  if (a.hasHashtags) scoreA += 100;
                  if (b.hasHashtags) scoreB += 100;
                  if (a.hasEmojis) scoreA += 50;
                  if (b.hasEmojis) scoreB += 50;
                  return scoreB - scoreA;
                });
                
                return candidates[0].text;
              });
              
              console.log(`\n📄 POST: "${actualPostContent.slice(0, 80)}${actualPostContent.length > 80 ? '...' : ''}"`);
              
              if (actualPostContent === 'No post content found') {
                console.log(`❌ ERROR: Could not extract post content`);
                results.push({ url: postUrl, success: false, error: 'Content extraction failed' });
                continue;
              }
              
              // Generate comment
              let aiComment;
              if (useAI) {
              const sessionAssistantId = await getSessionAssistantId(platform, sessionName);
              aiComment = await generateAIComment(actualPostContent, sessionAssistantId);
                console.log(`🤖 AI COMMENT: "${aiComment}"`);
              } else {
                aiComment = comment;
                console.log(`💬 MANUAL COMMENT: "${aiComment}"`);
              }
              
              // Like the post first if requested (on the already-loaded page)
            if (likePost) {
                try {
                  // Check if already liked (on current page)
                  const alreadyLiked = await page.evaluate(() => {
                    const likeButtons = document.querySelectorAll('[aria-label*="Like"], [data-testid*="like"]');
                    for (const btn of likeButtons) {
                      if (btn.getAttribute('aria-label')?.includes('Unlike') || 
                          btn.classList.contains('liked') ||
                          btn.style.color === 'rgb(255, 0, 0)') {
                        return true;
                      }
                    }
                    return false;
                  });
                  
                  if (alreadyLiked) {
                    console.log(`⏭️  SKIP LIKE: Post already liked → ${postUrl}`);
                  } else {
                    console.log(`❤️ Liking post (on current page): ${postUrl}`);
                    
                    // Like on current page without reloading
                    const likeSelectors = ['[aria-label="Like"]', '[data-testid*="like"]', 'button[aria-label*="Like"]'];
                    let liked = false;
                    
                    for (const selector of likeSelectors) {
                      try {
                        const likeButton = await page.$(selector);
                        if (likeButton) {
                          await likeButton.click();
                          console.log(`✅ Liked post using selector: ${selector}`);
                          liked = true;
                          await sleep(500); // Brief pause after liking
                          break;
                        }
                      } catch (error) {
                        continue;
                      }
                    }
                    
                    if (!liked) {
                      console.log(`⚠️ Could not find like button on current page`);
                    }
                  }
              } catch (likeError) {
                  console.log(`⚠️ Failed to like post ${postUrl}: ${likeError.message}`);
                  // Don't fail the whole operation if like fails
                }
              }
              
              // Comment on the already-loaded page
              console.log(`💬 Starting comment process (on current page): ${postUrl}`);
              try {
                // Look for reply button on current page
                const replySelectors = ['[aria-label="Reply"]', '[data-testid*="reply"]', 'button[aria-label*="reply"]'];
                let replyClicked = false;
                
                for (const selector of replySelectors) {
                  try {
                    const replyButton = await page.$(selector);
                    if (replyButton) {
                      await replyButton.click();
                      console.log(`✅ Reply button clicked using selector: ${selector}`);
                      replyClicked = true;
                      break;
                    }
                  } catch (error) {
                    continue;
                  }
                }
                
                if (!replyClicked) {
                  throw new Error('Could not find or click reply button on current page');
                }
                
                await sleep(2000); // Wait for comment box to appear
                
                // Look for comment text area
                const textareaSelectors = [
                  'textarea[placeholder*="reply"]',
                  'textarea[placeholder*="comment"]', 
                  'div[contenteditable="true"]',
                  'textarea'
                ];
                
                let commented = false;
                for (const selector of textareaSelectors) {
                  try {
                    const textarea = await page.$(selector);
                    if (textarea) {
                      await textarea.click();
                      await textarea.type(aiComment, { delay: 50 });
                      console.log(`✅ Comment typed using selector: ${selector}`);
                      
                      // Submit comment
                      const submitSelectors = ['button[type="submit"]', '[data-testid*="post"]', 'button[aria-label*="post"]'];
                      let submitted = false;
                      
                      for (const submitSelector of submitSelectors) {
                        try {
                          const submitButton = await page.$(submitSelector);
                          if (submitButton) {
                            await submitButton.click();
                            console.log(`✅ Comment submitted using selector: ${submitSelector}`);
                            submitted = true;
              break;
                          }
                        } catch (error) {
                          continue;
                        }
                      }
                      
                      if (!submitted) {
                        // Try keyboard shortcut
                        await page.keyboard.down('Meta');
                        await page.keyboard.press('Enter');
                        await page.keyboard.up('Meta');
                        console.log('✅ Comment submitted using Cmd+Enter');
                      }
                      
                      commented = true;
                      break;
                    }
          } catch (error) {
                    continue;
                  }
                }
                
                if (!commented) {
                  throw new Error('Could not find comment textarea on current page');
                }
                
                await sleep(2000); // Wait for comment to post
                console.log('✅ Comment posted successfully on current page');
                
              } catch (commentError) {
                throw new Error(`Comment failed: ${commentError.message}`);
              }
              
              // Mark as commented after successful comment
              await hasMyThreadsCommentAndCache({
                page,
                username,
                postUrl,
                markCommented: true
              });
              
              results.push({ url: postUrl, success: true, comment: aiComment });
              successfulComments++;
              
              console.log(`✅ COMPLETED: Comment posted successfully (${successfulComments}/${targetComments})`);
              
              if (successfulComments >= targetComments) {
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
        
        console.log(`\n🎉 FINAL RESULTS: ${successfulComments}/${targetComments} comments posted`);

        return {
          ok: true,
          message: `Auto-commented on ${successfulComments} posts (searched ${attempts} posts total)`, 
          results,
          attempts: successfulComments
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

    if (platform === 'bluesky') {
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
          
          await ensureBlueskyLoggedIn(page, { username, password });
          await saveSession(page, platform, sessionName, { assistantId });
          return { ok: true, message: 'Bluesky login successful' };
        } catch (error) {
          return { ok: false, message: `Bluesky login failed: ${error.message}` };
        }
      }

      if (action === 'auto-comment') {
        console.log('🦋 Starting Bluesky auto-comment...');
        
        if (!searchCriteria || (!searchCriteria.hashtag && !searchCriteria.keywords)) {
          return { ok: false, message: 'Search criteria (hashtag or keywords) required for auto-comment' };
        }

        // Ensure we're logged in before starting auto-comment
        try {
          // For auto-comment, we should already have a saved session
          // Only attempt login if we have credentials
          if (username && password) {
            await ensureBlueskyLoggedIn(page, { username, password });
          } else {
            // Use the same enhanced login detection logic as check-session
            const loginStatus = await page.evaluate(() => {
              const composeButton = document.querySelector('[aria-label*="Compose"], [data-testid*="compose"], button[aria-label*="compose" i]');
              const userMenu = document.querySelector('[aria-label*="Account"], [data-testid*="account"], [data-testid*="user"]');
              const feedIndicator = document.querySelector('[data-testid*="feed"], .feed, [aria-label*="feed"]');
              const homeIndicator = document.querySelector('[aria-label*="Home"], [data-testid*="home"]');
              
              const debugInfo = {
                url: window.location.href,
                title: document.title,
                cookies: document.cookie,
                localStorageKeys: Object.keys(localStorage),
                sessionStorageKeys: Object.keys(sessionStorage),
                foundElements: {
                  composeButton: !!composeButton,
                  userMenu: !!userMenu,
                  feedIndicator: !!feedIndicator,
                  homeIndicator: !!homeIndicator
                }
              };
              
              // Check localStorage for logged-out indicators
              const loggedOutIndicators = debugInfo.localStorageKeys.filter(key => 
                key.includes('logged-out') || key.includes('anonymous')
              );
              
              // Check for positive login indicators in localStorage
              const loggedInIndicators = debugInfo.localStorageKeys.filter(key => 
                key.includes('did:plc:') || key.includes('BSKY_STORAGE') || key.includes('agent-labelers')
              );
              
              // Strong login detection: UI elements OR localStorage indicators override stale logged-out keys
              const hasUIIndicators = !!(composeButton || userMenu);
              const hasStorageIndicators = loggedInIndicators.length > 0;
              const isLoggedIn = hasUIIndicators || hasStorageIndicators;
              
              debugInfo.isLoggedIn = isLoggedIn;
              debugInfo.loggedOutIndicators = loggedOutIndicators;
              debugInfo.loggedInIndicators = loggedInIndicators;
              debugInfo.hasUIIndicators = hasUIIndicators;
              debugInfo.hasStorageIndicators = hasStorageIndicators;
              
              return debugInfo;
            });
            
            console.log('🔍 Bluesky Login Status Debug:', JSON.stringify(loginStatus, null, 2));
            
            if (!loginStatus.isLoggedIn) {
              const uiStatus = loginStatus.hasUIIndicators ? '✅ UI elements present' : '❌ Missing UI elements';
              const storageStatus = loginStatus.hasStorageIndicators ? '✅ Auth data present' : '❌ No auth data';
              const reason = `${uiStatus}, ${storageStatus}`;
              return { ok: false, message: `Bluesky login required. Status: ${reason}. Please login again using the Login tab.` };
            }
            console.log('✅ Already logged into Bluesky from saved session');
          }
        } catch (error) {
          return { ok: false, message: `Bluesky login failed: ${error.message}` };
        }

        const maxPostsToProcess = parseInt(maxPosts) || 3;
        const targetSuccesses = maxPostsToProcess;
        console.log(`🎯 Target: ${targetSuccesses} successful comments`);

        try {
        const results = [];
          let successCount = 0;
          let processedPosts = new Set(); // Track processed posts to avoid duplicates
          let discoveryAttempts = 0;
          let consecutiveEmptyDiscoveries = 0;
          const maxConsecutiveEmpty = 3; // Only stop after 3 consecutive empty discoveries

          // Continue until target reached - no arbitrary limits on search attempts
          while (successCount < targetSuccesses) {
            discoveryAttempts++;
            console.log(`🔍 Discovery attempt ${discoveryAttempts}: Searching for posts (${successCount}/${targetSuccesses} comments completed)...`);
            
            // Discover more posts - increase batch size as we go to find more posts
            const batchSize = Math.max(20, (targetSuccesses - successCount) * 5);
            const discoveredPosts = await discoverBlueskyPosts(page, searchCriteria, batchSize);
            
            if (discoveredPosts.length === 0) {
              consecutiveEmptyDiscoveries++;
              console.log(`❌ No posts found in discovery attempt ${discoveryAttempts} (${consecutiveEmptyDiscoveries}/${maxConsecutiveEmpty} consecutive empty)`);
              
              if (consecutiveEmptyDiscoveries >= maxConsecutiveEmpty) {
                console.log(`⚠️ Stopping search after ${maxConsecutiveEmpty} consecutive empty discoveries - no more posts available`);
            break;
          }
          
              // Wait longer before next attempt when no posts found
              console.log('⏳ Waiting before retry...');
              await sleep(5000);
              continue;
            }

            // Reset consecutive empty counter when we find posts
            consecutiveEmptyDiscoveries = 0;

            // Filter out posts we've already processed
            const newPosts = discoveredPosts.filter(url => !processedPosts.has(url));
            console.log(`📊 Found ${discoveredPosts.length} posts, ${newPosts.length} new posts to process`);

            if (newPosts.length === 0) {
              console.log('⚠️ All discovered posts have already been processed, searching for more...');
              // Don't break here - continue searching for more posts
              await sleep(3000);
              continue;
            }

            // Process new posts
            for (const postUrl of newPosts) {
              if (successCount >= targetSuccesses) break;

              processedPosts.add(postUrl); // Mark as processed

              try {
                console.log(`\n🦋 [${successCount + 1}/${targetSuccesses}] Processing: ${postUrl}`);

                // Get post content for filtering
              const postContent = await getPostContent(page, postUrl, platform);
                console.log(`📄 POST CONTENT: "${postContent.slice(0, 80)}${postContent.length > 80 ? '...' : ''}"`);
                
                // Filter 1: Check text length (must be at least 5 words)
                const wordCount = postContent.trim().split(/\s+/).filter(word => word.length > 0).length;
                if (wordCount < 5) {
                  console.log(`⏭️  SKIP: Post too short (${wordCount} words, need 5+) → ${postUrl}`);
                  results.push({ 
                    url: postUrl, 
                    success: false, 
                    error: `Post too short (${wordCount} words)`,
                    skipped: true 
                  });
                  continue;
                }
                console.log(`✅ TEXT LENGTH: ${wordCount} words (sufficient)`);
                
                // Filter 2: Check for video content
                await page.goto(postUrl, { waitUntil: 'networkidle2' });
                await sleep(2000);
                
                const hasVideo = await page.evaluate(() => {
                  // Look for video elements in Bluesky
                  const videoSelectors = [
                    'video',
                    '[aria-label*="video" i]',
                    '[role="button"][aria-label*="play" i]',
                    'div[data-testid*="video"]',
                    '.video-player'
                  ];
                  
                  for (const selector of videoSelectors) {
                    if (document.querySelector(selector)) {
                      return true;
                    }
                  }
                  
                  // Check for video indicators in Bluesky
                  const pageText = document.body.textContent.toLowerCase();
                  if (pageText.includes('video') && (pageText.includes('play') || pageText.includes('watch'))) {
                    return true;
                  }
                  
                  return false;
                });
                
                if (hasVideo) {
                  console.log(`⏭️  SKIP: Post contains video content → ${postUrl}`);
                  results.push({ 
                    url: postUrl, 
                    success: false, 
                    error: 'Post contains video',
                    skipped: true 
                  });
                  continue;
                }
                console.log(`✅ VIDEO CHECK: No video content detected`);

                // Filter 3: Check if we've already commented on this post
                const alreadyCommented = await blueskyHasMyComment(page, postUrl, username);
                if (alreadyCommented) {
                  console.log(`🔄 DUPLICATE CHECK: Already commented → SKIPPING`);
                  results.push({ 
                    url: postUrl, 
                    success: false, 
                    error: 'Already commented',
                    skipped: true 
                  });
                  continue; // Skip to next post
                }
                console.log(`✅ DUPLICATE CHECK: No existing comment → PROCEEDING`);

              // Generate AI comment if needed
              let finalComment = comment || 'Great post!';
              if (useAI) {
                console.log('🤖 Generating AI comment...');
              const sessionAssistantId = await getSessionAssistantId(platform, sessionName);
                const postContent = await getPostContent(page, postUrl, platform);
                finalComment = await generateAIComment(postContent, sessionAssistantId);
              }

              // Like post if requested
              if (likePost) {
                console.log('❤️ Liking post...');
                await blueskyLike(page, postUrl);
                await sleep(1000);
              }

              // Comment on post
              console.log(`💬 Commenting: "${finalComment.slice(0, 50)}..."`);
              await blueskyComment(page, postUrl, finalComment);
              
              results.push({ 
                url: postUrl, 
                success: true, 
                comment: finalComment,
                liked: !!likePost
              });
              successCount++;
              
              console.log(`✅ Success! (${successCount}/${targetSuccesses} completed)`);
              
              // Delay between posts
              if (successCount < targetSuccesses) {
                console.log('⏳ Waiting before next post...');
                await sleep(3000);
              }
              
            } catch (error) {
                console.log(`❌ Error processing post: ${error.message}`);
                results.push({ 
                  url: postUrl, 
                  success: false, 
                  error: error.message 
                });
                await sleep(1000);
              }
            }

            // If we've reached our target, break out of discovery loop
            if (successCount >= targetSuccesses) {
              console.log(`🎯 Target reached! ${successCount}/${targetSuccesses} successful comments`);
              break;
            }

            // Small delay between discovery attempts
            console.log('⏳ Brief pause before next discovery attempt...');
            await sleep(2000);
          }

          const message = `Bluesky auto-comment completed: ${successCount}/${targetSuccesses} successful comments`;
          if (successCount < targetSuccesses) {
            console.log(`⚠️ Could not reach target. Processed ${processedPosts.size} total posts, found ${successCount} suitable for commenting.`);
          }
          return { ok: true, message, results };

        } catch (error) {
          return { ok: false, message: `Bluesky auto-comment failed: ${error.message}` };
        }
      }

      if (action === 'like') {
        if (url.includes(',')) {
          // Multiple URLs
          const urls = url.split(',').map(u => u.trim());
          const results = [];
          
          for (const postUrl of urls) {
            try {
              await blueskyLike(page, postUrl);
              results.push({ url: postUrl, success: true });
              await sleep(2000); // Delay between likes
            } catch (error) {
              results.push({ url: postUrl, success: false, error: error.message });
            }
          }
          
          return { ok: true, message: `Liked ${results.filter(r => r.success).length} Bluesky posts`, results };
        } else {
          // Single post like
          await blueskyLike(page, url);
        }
      }
      
      if (action === 'comment') {
        const sessionAssistantId = await getSessionAssistantId(platform, sessionName);
        const finalComment = useAI ? await generateAIComment('', sessionAssistantId) : comment;
        await blueskyComment(page, url, finalComment);
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
    // Only close browser if not in headful mode AND no platform contexts exist
    if (!headful) {
      try {
        if (browser && !browser.isConnected()) {
          console.log('Browser already disconnected');
        } else if (browser && platformContexts.size === 0) {
          // Only close if no platform contexts are active
          await browser.close();
          console.log('Browser closed successfully');
        } else if (browser && platformContexts.size > 0) {
          // Keep browser open to preserve platform contexts
          console.log(`Browser kept open to preserve ${platformContexts.size} platform context(s): ${Array.from(platformContexts.keys()).join(', ')}`);
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


// ===== BLUESKY FUNCTIONS =====

async function ensureBlueskyLoggedIn(page, { username, password }) {
  console.log('🦋 Checking Bluesky login status...');
  try {
    await page.goto('https://bsky.app/', { waitUntil: 'networkidle2' });
    await sleep(3000);
    
    // First check if already logged in
    const isLoggedIn = await page.evaluate(() => {
      const composeButton = document.querySelector('[aria-label*="Compose"]') || 
                           document.querySelector('[data-testid*="compose"]');
      const userMenu = document.querySelector('[aria-label*="Profile"]') || 
                      document.querySelector('[data-testid*="profile"]');
      return !!(composeButton || userMenu);
    });
    
    if (isLoggedIn) {
      console.log('✅ Already logged into Bluesky');
      return true;
    }
    
    console.log('🔐 Need to login - using simple settings page method...');
    
    // Use the simpler method: go to settings page and use Tab Tab Enter
    await page.goto('https://bsky.app/settings', { waitUntil: 'networkidle2' });
    await sleep(2000);
    
    console.log('⌨️ Using Tab Tab Enter sequence to access login...');
    console.log('⌨️ Pressing Tab key (first time)...');
    await page.keyboard.press('Tab');
    await sleep(500);
    
    console.log('⌨️ Pressing Tab key (second time)...');
    await page.keyboard.press('Tab');
    await sleep(500);
    
    console.log('⌨️ Pressing Enter key (should open login fields)...');
    await page.keyboard.press('Enter');
    await sleep(3000); // Give time for login fields to appear
    
    // Now look for and fill the login form
    console.log('📝 Looking for login form fields after keyboard navigation...');
    
    // Find username/email field
    const usernameSelectors = [
      'input[type="text"]',
      'input[type="email"]',
      'input[name*="identifier"]', 
      'input[name*="username"]',
      'input[name*="email"]',
      'input[name*="handle"]',
      'input[placeholder*="handle"]',
      'input[placeholder*="email"]',
      'input[placeholder*="username"]',
      'input[autocomplete="username"]',
      'input[autocomplete="email"]',
      'input:not([type="password"]):not([type="hidden"]):not([type="submit"])'
    ];
    
    let usernameField = null;
    for (const selector of usernameSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 3000 });
        usernameField = await page.$(selector);
        if (usernameField) {
          console.log(`📧 Found username field with selector: ${selector}`);
          break;
        }
      } catch (error) {
        continue;
      }
    }
    
    if (!usernameField) {
      throw new Error('Could not find username/email field in login form');
    }
    
    await usernameField.click();
    if (!username || typeof username !== 'string') {
      throw new Error('Username is required for Bluesky login but was not provided');
    }
    await usernameField.type(username);
    console.log(`✅ Entered username: ${username}`);
    
    // Find password field
    const passwordField = await page.waitForSelector('input[type="password"]', { timeout: 5000 });
    if (!passwordField) {
      throw new Error('Could not find password field in login form');
    }
    
    await passwordField.click();
    if (!password || typeof password !== 'string') {
      throw new Error('Password is required for Bluesky login but was not provided');
    }
    await passwordField.type(password);
    console.log('✅ Entered password');
    
    // Find and click the login submit button
    const submitSelectors = [
      'button[type="submit"]',
      'button:contains("Sign in")',
      'button:contains("Log in")',
      '[data-testid*="submit"]'
    ];
    
    let submitButton = null;
    for (const selector of submitSelectors) {
      try {
        if (selector.includes(':contains')) {
          submitButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(btn => 
              btn.textContent.toLowerCase().includes('sign in') || 
              btn.textContent.toLowerCase().includes('log in')
            );
          });
          if (submitButton) {
            console.log('🎯 Found submit button by text content');
            break;
          }
        } else {
          await page.waitForSelector(selector, { timeout: 3000 });
          submitButton = await page.$(selector);
          if (submitButton) {
            console.log(`🎯 Found submit button with selector: ${selector}`);
            break;
          }
        }
      } catch (error) {
        continue;
      }
    }
    
    if (!submitButton) {
      console.log('⚠️ Could not find submit button, will try Enter key after filling password');
    }
    
    // Submit login form (try button click, fallback to Enter key)
    console.log('🚀 Submitting login form...');
    if (submitButton) {
      try {
        await submitButton.click();
        console.log('✅ Submit button clicked successfully');
      } catch (error) {
        console.log('⚠️ Submit button click failed, trying Enter key...');
        await page.keyboard.press('Enter');
        console.log('✅ Enter key pressed for form submission');
      }
    } else {
      console.log('⚠️ No submit button found, using Enter key...');
      await page.keyboard.press('Enter');
      console.log('✅ Enter key pressed for form submission');
    }
    await sleep(4000); // Give it time to process login
    
    // Verify login success
    const loginSuccess = await page.evaluate(() => {
      const composeButton = document.querySelector('[aria-label*="Compose"]') || 
                           document.querySelector('[data-testid*="compose"]');
      const userMenu = document.querySelector('[aria-label*="Profile"]') || 
                      document.querySelector('[data-testid*="profile"]');
      return !!(composeButton || userMenu);
    });
    
    if (loginSuccess) {
      console.log('✅ Bluesky login successful');
      return true;
    } else {
      throw new Error('Login appeared to fail - compose button not found after login attempt');
    }
    
  } catch (error) {
    console.error('❌ Bluesky login error:', error.message);
    throw new Error(`Bluesky login error: ${error.message}`);
  }
}

async function blueskyLike(page, postUrl) {
  console.log(`❤️ Attempting to like Bluesky post: ${postUrl}`);
  await page.goto(postUrl, { waitUntil: 'networkidle2' });
  await sleep(1000);
  
  // Check if already liked before attempting
  const alreadyLiked = await page.evaluate(() => {
    // Look for indicators that the post is already liked
    const likedIndicators = document.querySelectorAll('[aria-label*="Unlike"], [aria-pressed="true"], .liked, [data-state="liked"]');
    return likedIndicators.length > 0;
  });
  
  if (alreadyLiked) {
    console.log('ℹ️ Post is already liked, skipping...');
    return { success: true, alreadyLiked: true };
  }
  
  const likeSelectors = [
    // Target the actual heart button, not counters or text
    'button[aria-label="Like"][role="button"]',
    'button[aria-label="Like"]:not([aria-pressed="true"])',
    '[data-testid="likeBtn"]:not([aria-pressed="true"])',
    '[data-testid="like"]:not([aria-pressed="true"])',
    // Heart icon specific selectors
    'button[aria-label^="Like"]:not([aria-label*="likes"]):not([aria-label*="liked by"])',
    'button svg[data-icon="heart"]',
    'button:has(svg[data-icon="heart"])',
    // Fallback with role specification
    '[role="button"][aria-label*="Like"]:not([aria-label*="likes"]):not([aria-label*="liked by"])'
  ];
  
  for (const selector of likeSelectors) {
    try {
      console.log(`🔍 Trying like selector: ${selector}`);
      await page.waitForSelector(selector, { timeout: 2000 });
      const element = await page.$(selector);
      if (element) {
        // Validate this is actually a like button, not a counter or text
        const elementInfo = await element.evaluate(el => ({
          ariaPressed: el.getAttribute('aria-pressed'),
          ariaLabel: el.getAttribute('aria-label'),
          className: el.className,
          tagName: el.tagName,
          role: el.getAttribute('role'),
          textContent: el.textContent?.trim(),
          hasHeartIcon: !!el.querySelector('svg[data-icon="heart"], [data-icon="heart"]'),
          isButton: el.tagName === 'BUTTON' || el.getAttribute('role') === 'button'
        }));
        
        console.log(`🔍 Element validation:`, elementInfo);
        
        // Skip if this looks like a counter (contains numbers) or text display
        if (elementInfo.textContent && /\d+.*like/i.test(elementInfo.textContent)) {
          console.log('⚠️ Skipping element - appears to be like counter, not button');
          continue;
        }
        
        // Skip if not actually a clickable button
        if (!elementInfo.isButton) {
          console.log('⚠️ Skipping element - not a button or clickable element');
          continue;
        }
        
        const beforeState = {
          ariaPressed: elementInfo.ariaPressed,
          ariaLabel: elementInfo.ariaLabel,
          className: elementInfo.className
        };
        
        await element.click();
        await sleep(1000); // Wait for state change
        
        // Verify the like actually worked by checking state change
        const afterState = await element.evaluate(el => ({
          ariaPressed: el.getAttribute('aria-pressed'),
          ariaLabel: el.getAttribute('aria-label'),
          className: el.className
        }));
        
        console.log('🔍 Like button state change:', { before: beforeState, after: afterState });
        
        // Check if the state indicates success
        const likeSuccessful = afterState.ariaPressed === 'true' || 
                              afterState.ariaLabel?.includes('Unlike') ||
                              afterState.className?.includes('liked');
        
        if (likeSuccessful) {
          console.log('✅ Bluesky post liked successfully - verified by state change!');
          return { success: true };
        } else {
          console.log('⚠️ Like button clicked but no state change detected');
        }
      }
    } catch (error) {
      console.log(`⚠️ Like selector failed: ${selector} - ${error.message}`);
      continue;
    }
  }
  
  throw new Error('Could not find or successfully click like button on Bluesky post');
}

async function blueskyComment(page, postUrl, comment) {
  console.log(`💬 Attempting to comment on Bluesky post: ${postUrl}`);
  await page.goto(postUrl, { waitUntil: 'networkidle2' });
  await sleep(2000);
  
  try {
    // Look for reply button with enhanced selectors
    console.log('🔍 Looking for reply button...');
    const replySelectors = [
      '[aria-label*="Reply"]',
      '[data-testid*="reply"]', 
      'button[aria-label*="reply"]',
      '[aria-label*="reply" i]',
      'button:contains("Reply")',
      '[role="button"][aria-label*="Reply"]'
    ];
    
    let replyButton = null;
    for (const selector of replySelectors) {
      try {
        if (selector.includes(':contains')) {
          replyButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(btn => btn.textContent.toLowerCase().includes('reply'));
          });
          if (replyButton && await replyButton.evaluate(el => el)) {
            console.log('🎯 Found reply button by text content');
            break;
          }
        } else {
          await page.waitForSelector(selector, { timeout: 2000 });
          replyButton = await page.$(selector);
          if (replyButton) {
            console.log(`🎯 Found reply button with selector: ${selector}`);
            break;
          }
        }
      } catch (error) {
        continue;
      }
    }
    
    if (!replyButton) {
      throw new Error('Could not find reply button on Bluesky post');
    }
    
    await replyButton.click();
    console.log('✅ Reply button clicked, waiting for comment area...');
    await sleep(2000);
    
    // Look for comment textarea with enhanced selectors
    console.log('🔍 Looking for comment textarea...');
    const textareaSelectors = [
      'textarea',
      '[contenteditable="true"]',
      '[data-testid*="composer"]',
      '[data-testid*="text"]',
      '[placeholder*="Write"]',
      '[placeholder*="Reply"]',
      '[role="textbox"]',
      'div[contenteditable="true"]',
      'textarea[placeholder*="reply"]'
    ];
    
    let textarea = null;
    for (const selector of textareaSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 2000 });
        textarea = await page.$(selector);
        if (textarea) {
          console.log(`🎯 Found textarea with selector: ${selector}`);
          break;
        }
      } catch (error) {
        continue;
      }
    }
    
    if (!textarea) {
      // Debug what elements are actually available
      const availableElements = await page.evaluate(() => {
        const elements = [];
        document.querySelectorAll('textarea, [contenteditable], [role="textbox"], input[type="text"]').forEach(el => {
          elements.push({
            tagName: el.tagName,
            type: el.type || 'none',
            contentEditable: el.contentEditable,
            placeholder: el.placeholder || 'none',
            'data-testid': el.getAttribute('data-testid') || 'none',
            'aria-label': el.getAttribute('aria-label') || 'none',
            role: el.getAttribute('role') || 'none'
          });
        });
        return elements;
      });
      
      console.log('🔍 Available text input elements:', JSON.stringify(availableElements, null, 2));
      throw new Error('Could not find comment textarea on Bluesky post');
    }
    
    await textarea.click();
    await sleep(500);
    await textarea.type(comment);
    console.log('✅ Comment text entered');
    await sleep(1000);
    
    // Look for submit button with enhanced selectors
    console.log('🔍 Looking for submit button...');
    const submitSelectors = [
      'button[type="submit"]',
      '[data-testid*="post"]',
      '[aria-label*="Post"]',
      'button:contains("Post")',
      'button:contains("Reply")',
      '[data-testid*="reply"]',
      '[role="button"][aria-label*="Post"]'
    ];
    
    let submitButton = null;
    for (const selector of submitSelectors) {
      try {
        if (selector.includes(':contains')) {
          submitButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(btn => 
              btn.textContent.toLowerCase().includes('post') || 
              btn.textContent.toLowerCase().includes('reply')
            );
          });
          if (submitButton && await submitButton.evaluate(el => el)) {
            console.log('🎯 Found submit button by text content');
            break;
          }
        } else {
          await page.waitForSelector(selector, { timeout: 2000 });
          submitButton = await page.$(selector);
          if (submitButton) {
            console.log(`🎯 Found submit button with selector: ${selector}`);
            break;
          }
        }
      } catch (error) {
        continue;
      }
    }
    
    if (!submitButton) {
      // Try keyboard shortcut as fallback
      console.log('⚠️ No submit button found, trying Cmd+Enter...');
      await textarea.focus(); // Ensure textarea is focused
      await page.keyboard.down('Meta');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Meta');
      console.log('✅ Cmd+Enter pressed for comment submission');
    } else {
      console.log('🎯 Clicking submit button...');
      await submitButton.click();
      await sleep(500);
      
      // Fallback: If button click didn't work, try keyboard shortcut
      console.log('🔄 Also trying Cmd+Enter as backup...');
      await textarea.focus();
      await page.keyboard.down('Meta');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Meta');
      console.log('✅ Submit button clicked + Cmd+Enter backup');
    }
    
    // Quick check if comment is still in textarea (immediate failure detection)
    await sleep(1000);
    const immediateCheck = await page.evaluate((commentText) => {
      const textareas = document.querySelectorAll('textarea, [contenteditable="true"]');
      let stillInTextarea = false;
      textareas.forEach(ta => {
        if (ta.value?.toLowerCase().includes(commentText.toLowerCase()) || 
            ta.innerText?.toLowerCase().includes(commentText.toLowerCase())) {
          stillInTextarea = true;
        }
      });
      return stillInTextarea;
    }, comment);
    
    if (immediateCheck) {
      console.log('⚠️ Comment still in textarea after 1s, trying alternative submission...');
      // Try alternative submission methods
      await textarea.focus();
      await sleep(500);
      
      // Try Tab to submit button then Enter
      await page.keyboard.press('Tab');
      await sleep(200);
      await page.keyboard.press('Enter');
      console.log('🔄 Tried Tab+Enter submission');
      
      await sleep(1000);
      
      // If still there, try Escape then resubmit
      const stillThere = await page.evaluate((commentText) => {
        const textareas = document.querySelectorAll('textarea, [contenteditable="true"]');
        return Array.from(textareas).some(ta => 
          ta.value?.toLowerCase().includes(commentText.toLowerCase()) || 
          ta.innerText?.toLowerCase().includes(commentText.toLowerCase())
        );
      }, comment);
      
      if (stillThere) {
        console.log('🔄 Final attempt: Ctrl+Enter...');
        await textarea.focus();
        await page.keyboard.down('Control');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Control');
      }
    }
    
    await sleep(2000); // Give more time for comment to appear
    
    // Enhanced verification: Check for success indicators AND comment presence
    console.log('🔍 Verifying comment was posted...');
    const commentVerification = await page.evaluate((commentText) => {
      const commentLower = commentText.toLowerCase();
      
      // Look for success indicators (new comment elements, success messages, etc.)
      const successIndicators = document.querySelectorAll('[data-testid*="success"], .success, [aria-label*="success"]');
      
      // Look for recently added comment elements (usually have timestamp indicators)
      const recentComments = document.querySelectorAll('[data-testid*="post"]:not([data-testid*="original"]), [role="article"]:has([data-testid*="reply"])');
      
      // Check if our comment text appears in recent comments specifically
      let foundInRecentComment = false;
      let recentCommentTexts = [];
      
      recentComments.forEach((el, index) => {
        const text = el.innerText?.toLowerCase() || '';
        recentCommentTexts.push(text.substring(0, 100)); // First 100 chars for debugging
        
        // Only consider it a match if:
        // 1. The comment text is substantial (not just "thanks" or "great")
        // 2. The element looks like a new comment (has reply indicators)
        // 3. The text match is significant (not just a word overlap)
        if (commentText.length > 10 && // Substantial comment
            text.includes(commentLower) && 
            (el.querySelector('[data-testid*="reply"]') || el.querySelector('[aria-label*="reply"]'))) {
          foundInRecentComment = true;
        }
      });
      
      // Additional check: Look for our comment in the textarea (might still be there if failed)
      const textareas = document.querySelectorAll('textarea, [contenteditable="true"]');
      let commentStillInTextarea = false;
      textareas.forEach(textarea => {
        if (textarea.value?.toLowerCase().includes(commentLower) || 
            textarea.innerText?.toLowerCase().includes(commentLower)) {
          commentStillInTextarea = true;
        }
      });
      
      return {
        foundInRecentComment,
        recentCommentCount: recentComments.length,
        recentCommentTexts: recentCommentTexts.slice(0, 3), // First 3 for debugging
        successIndicatorsFound: successIndicators.length,
        commentStillInTextarea, // If true, submission likely failed
        commentLength: commentText.length
      };
    }, comment);
    
    console.log('🔍 Enhanced comment verification:', commentVerification);
    
    // More strict verification: require finding in recent comments AND not still in textarea
    const verificationPassed = commentVerification.foundInRecentComment && 
                               !commentVerification.commentStillInTextarea &&
                               commentVerification.recentCommentCount > 0;
    
    if (verificationPassed) {
      console.log('✅ Bluesky comment posted successfully - verified in recent comments!');
      return { success: true, verified: true };
    } else {
      const reason = commentVerification.commentStillInTextarea ? 
        'Comment text still in textarea (submission likely failed)' :
        !commentVerification.foundInRecentComment ? 
          'Comment not found in recent comment elements' :
          'No recent comments detected on page';
          
      console.log(`⚠️ Comment verification failed: ${reason}`);
      console.log('🔍 This may indicate the comment did not actually post to Bluesky');
      return { success: false, verified: false, message: `Comment verification failed: ${reason}` };
    }
    
  } catch (error) {
    console.error('❌ Bluesky comment error:', error.message);
    throw new Error(`Bluesky comment error: ${error.message}`);
  }
}

async function blueskyHasMyComment(page, postUrl, username) {
  console.log(`🔍 Checking if ${username} already commented on: ${postUrl}`);
  
  try {
    // Navigate to the post
    await page.goto(postUrl, { waitUntil: 'networkidle2' });
    await sleep(2000); // Wait for comments to load
    
    // Look for existing comments from this user
    const hasComment = await page.evaluate((username) => {
      // Multiple selectors to find comments
      const commentSelectors = [
        '[data-testid*="post"]',
        '[role="article"]',
        '.post',
        '.comment',
        '[data-testid*="reply"]'
      ];
      
      let foundMyComment = false;
      
      commentSelectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach(element => {
          const elementText = element.innerText || element.textContent || '';
          
          // Look for username patterns in the comment
          if (elementText.includes(`@${username}`) || 
              elementText.includes(username) ||
              element.querySelector(`[href*="${username}"]`)) {
            
            // Additional check: make sure this looks like a comment, not just a mention
            const hasCommentIndicators = element.querySelector('[aria-label*="reply"]') ||
                                        element.querySelector('[data-testid*="reply"]') ||
                                        element.querySelector('[aria-label*="comment"]') ||
                                        elementText.length > 10; // Substantial text
            
            if (hasCommentIndicators) {
              console.log(`🔍 Found potential comment from ${username}:`, elementText.slice(0, 100));
              foundMyComment = true;
            }
          }
        });
      });
      
      return foundMyComment;
    }, username);
    
    if (hasComment) {
      console.log(`✅ Found existing comment from ${username}`);
      return true;
    } else {
      console.log(`❌ No existing comment found from ${username}`);
      return false;
    }
    
  } catch (error) {
    console.log(`⚠️ Error checking for existing comment: ${error.message}`);
    // If we can't check, assume no comment to be safe
    return false;
  }
}

async function discoverBlueskyPosts(page, searchCriteria, maxPosts = 10) {
  console.log(`🦋 Starting Bluesky post discovery`);
  
  const { hashtag, keywords } = searchCriteria;
  let searchQuery = hashtag || keywords;
  
  if (!searchQuery) {
    throw new Error('Either hashtag or keywords must be provided');
  }
  
  // Listen for token expiration errors
  page.on('pageerror', (error) => {
    if (error.message.includes('Token has expired')) {
      console.log('🔍 Detected Bluesky token expiration error');
    }
  });

  // Try multiple search formats
  const searchFormats = [
    searchQuery,                    // Original query (e.g., "inspiringquotes")
    `#${searchQuery}`,             // With hashtag (e.g., "#inspiringquotes")
    searchQuery.replace('#', '')   // Without hashtag (e.g., "inspiringquotes" if input was "#inspiringquotes")
  ];
  
  console.log(`🔍 Will try search formats:`, searchFormats);
  
  let bestResults = [];
  let bestUrl = '';
  let tokenExpired = false;
  
  for (const format of searchFormats) {
    const searchUrl = `https://bsky.app/search?q=${encodeURIComponent(format)}&sort=latest`;
    console.log(`🔍 Trying search (latest): ${searchUrl}`);
    
    try {
      await page.goto(searchUrl, { waitUntil: 'networkidle2' });
      await sleep(3000);
      
      // Check for token expiration in page content
      const pageText = await page.evaluate(() => document.body.textContent);
      if (pageText.includes('Search is currently unavailable when logged out')) {
        console.log('⚠️ Bluesky search unavailable - token likely expired');
        tokenExpired = true;
        break;
      }
      
      // Quick check for posts on this format
      const quickCheck = await page.evaluate(() => {
        const postElements = document.querySelectorAll('a[href*="/post/"]');
        return postElements.length;
      });
      
      console.log(`🔍 Format "${format}" found ${quickCheck} potential posts`);
      
      if (quickCheck > bestResults.length) {
        bestResults = Array(quickCheck);
        bestUrl = searchUrl;
      }
      
      // If we found posts, use this format
      if (quickCheck > 0) {
        console.log(`✅ Using search format: "${format}" (${quickCheck} posts found)`);
        break;
      }
    } catch (error) {
      console.log(`⚠️ Search format "${format}" failed: ${error.message}`);
    }
  }
  
  // Handle token expiration
  if (tokenExpired) {
    console.log('🔄 Attempting to refresh Bluesky session due to token expiration...');
    try {
      // Navigate to settings to trigger re-authentication
      await page.goto('https://bsky.app/settings', { waitUntil: 'networkidle2' });
      await sleep(2000);
      
      // Try the Tab, Tab, Enter sequence to open login
      await page.keyboard.press('Tab');
      await sleep(500);
      await page.keyboard.press('Tab'); 
      await sleep(500);
      await page.keyboard.press('Enter');
      await sleep(3000);
      
      console.log('⚠️ Bluesky token expired - manual re-login required');
      throw new Error('Bluesky session expired - please login manually and save session again');
    } catch (refreshError) {
      console.log('❌ Failed to refresh Bluesky token:', refreshError.message);
      throw new Error('Bluesky session expired and refresh failed');
    }
  }
  
  if (bestResults.length === 0) {
    console.log(`⚠️ No search format found posts, using last tried URL: ${bestUrl || searchFormats[0]}`);
  }
  
  await sleep(2000); // Additional wait for final content loading
  
  // First, check if we're on the right page and can see content
  const pageStatus = await page.evaluate(() => {
    return {
      url: window.location.href,
      title: document.title,
      hasContent: document.body.textContent.length > 100,
      elementCount: document.querySelectorAll('*').length
    };
  });
  console.log(`🔍 Page status:`, pageStatus);
  
  // Try multiple selectors to find posts
  const posts = await page.evaluate(() => {
    const selectors = [
      'a[href*="/post/"]',                    // Original selector
      'a[href*="/profile/"][href*="/post/"]', // More specific
      '[data-testid*="post"] a[href*="/post/"]', // With testid
      'article a[href*="/post/"]',            // In article elements
      '[role="article"] a[href*="/post/"]',   // Role-based
      'div[data-testid*="feedItem"] a[href*="/post/"]' // Feed item specific
    ];
    
    const foundUrls = new Set();
    const debug = {
      selectorsChecked: [],
      elementsFound: 0
    };
    
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      debug.selectorsChecked.push(`${selector}: ${elements.length} found`);
      debug.elementsFound += elements.length;
      
      elements.forEach(element => {
        const href = element.getAttribute('href');
        if (href && href.includes('/post/')) {
          const fullUrl = href.startsWith('http') ? href : `https://bsky.app${href}`;
          foundUrls.add(fullUrl);
        }
      });
    }
    
    // Also try looking for any links that might be posts
    const allLinks = document.querySelectorAll('a[href]');
    debug.allLinksCount = allLinks.length;
    
    allLinks.forEach(link => {
      const href = link.getAttribute('href');
      if (href && href.includes('/post/') && href.includes('/profile/')) {
        const fullUrl = href.startsWith('http') ? href : `https://bsky.app${href}`;
        foundUrls.add(fullUrl);
      }
    });
    
    return {
      urls: Array.from(foundUrls),
      debug
    };
  });
  
  console.log(`🔍 Discovery debug:`, posts.debug);
  console.log(`🦋 Found ${posts.urls.length} potential Bluesky posts`);
  
  // If no posts found, provide additional debugging
  if (posts.urls.length === 0) {
    console.log(`🔍 No posts found - additional debugging:`);
    
    // Check if we're on the right page
    const pageInfo = await page.evaluate(() => {
      return {
        url: window.location.href,
        title: document.title,
        bodyText: document.body.innerText.substring(0, 500),
        hasSearchResults: document.body.innerText.includes('Search'),
        hasLoginPrompt: document.body.innerText.includes('Sign up') || document.body.innerText.includes('Log in'),
        linkCount: document.querySelectorAll('a').length,
        postLinkCount: document.querySelectorAll('a[href*="/post/"]').length,
        profileLinkCount: document.querySelectorAll('a[href*="/profile/"]').length
      };
    });
    
    console.log(`🔍 Page analysis:`, pageInfo);
    
    // Try alternative search approaches
    if (pageInfo.hasLoginPrompt) {
      console.log(`⚠️ Login prompt detected - may need to re-authenticate`);
    }
    
    if (pageInfo.linkCount === 0) {
      console.log(`⚠️ No links found on page - may be loading issue`);
    }
  }
  
  return posts.urls.slice(0, maxPosts);
}