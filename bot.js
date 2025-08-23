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
import { hasMyThreadsCommentAndCache, clearThreadsCommentCache, getThreadsCommentCacheStats, hasMyThreadsLike } from './utils/threadsHasMyComment.js';

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

function getSessionFilePath(platform, sessionName) {
  const sessionsDir = path.join(__dirname, '.sessions');
  const sessionPath = path.join(sessionsDir, `session_${platform}_${sessionName}.json`);
  return { sessionsDir, sessionPath };
}

async function ensureSessionsDirectory() {
  const { sessionsDir } = getSessionFilePath('threads', 'default');
  try {
    await fs.access(sessionsDir);
  } catch {
  await fs.mkdir(sessionsDir, { recursive: true });
  }
}

async function saveSession(page, platform, sessionName) {
  try {
    await ensureSessionsDirectory();
    const { sessionPath } = getSessionFilePath(platform, sessionName);
    
    const sessionData = await page.evaluate(() => {
      return {
        cookies: document.cookie,
        localStorage: Object.fromEntries(
          Object.entries(localStorage).map(([key, value]) => [key, value])
        ),
        sessionStorage: Object.fromEntries(
          Object.entries(sessionStorage).map(([key, value]) => [key, value])
        )
      };
    });
    
    // Add platform information to session data
    sessionData.platform = platform;
    sessionData.timestamp = new Date().toISOString();
    
    await fs.writeFile(sessionPath, JSON.stringify(sessionData, null, 2));
    console.log(`✅ Session saved: ${sessionPath}`);
    return true;
  } catch (error) {
    console.error('Error saving session:', error);
    return false;
  }
}

async function loadSession(page, platform, sessionName) {
  try {
    const { sessionPath } = getSessionFilePath(platform, sessionName);
    
    const sessionData = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
    
    // Set cookies
    if (sessionData.cookies) {
      const cookies = sessionData.cookies.split(';').map(cookie => {
        const [name, value] = cookie.trim().split('=');
        return { name, value };
      });
      
      for (const cookie of cookies) {
        if (cookie.name && cookie.value) {
          await page.setCookie(cookie);
        }
      }
    }
    
    // Set localStorage
    if (sessionData.localStorage) {
      await page.evaluate((localStorageData) => {
        for (const [key, value] of Object.entries(localStorageData)) {
          localStorage.setItem(key, value);
        }
      }, sessionData.localStorage);
    }
    
    // Set sessionStorage
    if (sessionData.sessionStorage) {
      await page.evaluate((sessionStorageData) => {
        for (const [key, value] of Object.entries(sessionStorageData)) {
          sessionStorage.setItem(key, value);
        }
      }, sessionData.sessionStorage);
    }
    
    console.log(`✅ Session loaded: ${sessionPath}`);
                  return true;
    } catch (error) {
    console.log(`Session not found or invalid: ${error.message}`);
  return false;
  }
}

async function getSessionAssistantId(platform, sessionName) {
  try {
    const { sessionPath } = getSessionFilePath(platform, sessionName);
    const sessionData = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
    return sessionData.assistantId;
      } catch (error) {
    console.log(`Could not get assistant ID from session: ${error.message}`);
    return null;
  }
}

async function generateAIComment(postContent, assistantId) {
  if (!openai || !assistantId) {
    throw new Error('OpenAI client or assistant ID not available');
  }

  try {
    console.log('🤖 Generating AI comment...');

    const thread = await openai.beta.threads.create();

    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: `Generate a thoughtful, engaging comment for this social media post. The comment should be authentic, relevant to the content, and encourage positive interaction. Keep it under 200 characters. Here's the post content: "${postContent}"`
    });
    
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: assistantId
    });
    
    // Wait for the run to complete
    let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    while (runStatus.status === 'in_progress' || runStatus.status === 'queued') {
      await sleep(1000);
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    }
    
    if (runStatus.status === 'completed') {
      const messages = await openai.beta.threads.messages.list(thread.id);
      const lastMessage = messages.data[0];
      const comment = lastMessage.content[0].text.value.trim();
      
      console.log(`🤖 AI comment generated: "${comment}"`);
      return comment;
    } else {
      throw new Error(`AI generation failed with status: ${runStatus.status}`);
    }
  } catch (error) {
    console.error('AI comment generation error:', error);
    throw new Error(`AI comment generation failed: ${error.message}`);
  }
}

async function getPostContent(page, postUrl, platform) {
  console.log(`🚀 getPostContent called for ${platform} post: ${postUrl}`);
  await page.goto(postUrl, { waitUntil: 'networkidle2' });

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

async function checkSessionStatus(page, platform, sessionName = 'default') {
  try {
    await loadSession(page, platform, sessionName);
    
    if (platform === 'threads') {
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

async function launchBrowser(headful = false, platform = null) {
  let page;
  try {
    if (headful) {
      // For headful mode, reuse existing browser if available
      if (globalBrowser) {
        console.log('Reusing existing headful browser');
        page = await globalBrowser.newPage();
        return { browser: globalBrowser, page };
      }
      
      console.log('Launching new headful browser');
      globalBrowser = await puppeteer.launch({
        headless: false,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ]
      });
      
      page = await globalBrowser.newPage();
      return { browser: globalBrowser, page };
    } else {
      // For headless mode, create isolated contexts per platform
      if (platform) {
        if (platformContexts.has(platform)) {
          // Reuse existing isolated context
          const existingContext = platformContexts.get(platform);
          page = await existingContext.context.newPage();
          return { browser: existingContext.browser, page };
        } else {
          // Create new isolated context
          const browser = await puppeteer.launch({
            headless: true,
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-accelerated-2d-canvas',
              '--no-first-run',
              '--no-zygote',
              '--disable-gpu'
            ]
          });
          
          const context = await browser.createBrowserContext();
          page = await context.newPage();
          platformContexts.set(platform, { context, browser });
          return { browser, page };
        }
      } else {
        // No platform specified, create regular browser
        const browser = await puppeteer.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
          ]
        });
        
        page = await browser.newPage();
        return { browser, page };
      }
    }
  } catch (error) {
    console.error('Error launching browser:', error);
    throw error;
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
    progressSessionId,
    sendProgress,
  } = options;

  // Progress tracking helper
  const reportProgress = (step, details = {}) => {
    console.log(`📊 reportProgress called: ${step}`, details);
    if (sendProgress) {
      console.log(`📡 Sending progress via callback`);
      sendProgress({
        step,
        platform,
        action,
        sessionName,
        ...details
      });
    } else {
      console.log(`⚠️ No sendProgress callback available`);
    }
  };

  let browser;
  let page;

  try {
    // Validation - only Threads platform supported
    if (!platform || platform !== 'threads') {
      throw new Error('Only Threads platform is supported');
    }
    if (!action || !['login', 'auto-comment', 'check-session', 'logout'].includes(action)) {
      throw new Error('Invalid or missing action');
    }
    if (action === 'auto-comment' && !searchCriteria) {
      throw new Error('searchCriteria is required for auto-comment action');
    }

    // Report initial progress
    reportProgress('🌐 Opening browser...', { current: 0, total: 100 });
    
    // Launch browser with platform isolation for headful mode
    const browserResult = await launchBrowser(headful, platform);
    browser = browserResult.browser;
    page = browserResult.page;
    
    reportProgress('🔐 Authenticating...', { current: 20, total: 100 });

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
      
      // Check Threads login status
      await page.goto('https://www.threads.net/', { waitUntil: 'networkidle2' });
        
        const loginStatus = await page.evaluate(() => {
          const composeButton = document.querySelector('[aria-label*="Compose"], [data-testid*="compose"], button[aria-label*="compose" i]');
          const userMenu = document.querySelector('[aria-label*="Account"], [data-testid*="account"], [data-testid*="user"]');
          const feedIndicator = document.querySelector('[data-testid*="feed"], .feed, [aria-label*="feed"]');
          const homeIndicator = document.querySelector('[aria-label*="Home"], [data-testid*="home"]');
          
        return !!(composeButton || userMenu || feedIndicator || homeIndicator);
      });
      
      if (loginStatus) {
        return { ok: true, message: 'Session is valid and logged in' };
            } else {
        return { ok: false, message: 'Session is invalid or expired' };
      }
    }

    // Handle login action
    if (action === 'login') {
      if (!username || !password) {
        throw new Error('Username and password are required for login');
      }

      // Load existing session first
    const sessionLoaded = await loadSession(page, platform, sessionName);
    
      // Navigate to Threads
      await page.goto('https://www.threads.net/', { waitUntil: 'networkidle2' });
      
      // Try to login using Threads functions
      const loginSuccess = await ensureThreadsLoggedIn(page, { username, password });
      
      if (loginSuccess) {
        // Save session after successful login
        const sessionSaved = await saveSession(page, platform, sessionName);
        if (sessionSaved) {
          return { ok: true, message: 'Login successful and session saved' };
        } else {
          return { ok: true, message: 'Login successful but session save failed' };
        }
      } else {
        return { ok: false, message: 'Login failed' };
      }
    }

    // Handle auto-comment action
    if (action === 'auto-comment') {
      // Load session first
      const sessionLoaded = await loadSession(page, platform, sessionName);
      
      // Ensure logged in
      await ensureThreadsLoggedIn(page, { username, password });
      
      reportProgress('🔍 Discovering posts...', { current: 30, total: 100 });
      
      // Parse search criteria
        const parsedCriteria = typeof searchCriteria === 'string' 
          ? (searchCriteria.startsWith('#') 
              ? { hashtag: searchCriteria } 
              : { keywords: searchCriteria })
          : searchCriteria;
      
      // Discover posts
      const posts = await discoverThreadsPosts(page, parsedCriteria, maxPosts * 3); // Get more posts to account for skips
      console.log(`Found ${posts.length} Threads posts to process`);
      
      if (posts.length === 0) {
        return { ok: false, message: 'No posts found matching search criteria' };
      }
      
      reportProgress('💬 Starting auto-comment...', { current: 40, total: 100 });
      
      const targetSuccesses = maxPosts;
        let successes = 0;
      const results = [];
        let attempts = 0;
      const maxAttempts = posts.length;
      
      for (const postUrl of posts) {
          attempts++;
        console.log(`\n🔄 [${attempts}/${posts.length}] Processing: ${postUrl}`);
        
        try {
          // Get post content for AI comment generation
            const postContent = await getPostContent(page, postUrl, platform);
          if (!postContent || postContent.length < 10) {
            console.log(`⚠️ SKIP: No substantial content found`);
            results.push({ url: postUrl, success: false, error: 'No substantial content' });
            continue;
          }
          
          // Check for duplicate comments
          const already = await hasMyThreadsCommentAndCache(page, postUrl, username);
            if (already) {
              console.log(`🔄 DUPLICATE CHECK: Already commented → SKIPPING`);
              results.push({ url: postUrl, success: false, error: 'Already commented' });
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

          // Post the comment
          const commentResult = await threadsComment(page, postUrl, aiComment);

            if (commentResult.skipped) {
              console.log(`⏭️ SKIPPED: ${commentResult.reason}`);
              results.push({ url: postUrl, success: false, error: commentResult.reason });
            } else {
              // Like the post if requested
              if (likePost) {
                try {
                  console.log(`❤️ Liking post: ${postUrl}`);
                const likeResult = await threadsLike(page, postUrl);
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
              
              // Report success progress
            reportProgress(`✅ Threads comment posted! (${successes}/${targetSuccesses})`, {
          current: 40 + (successes / targetSuccesses) * 50,
          total: 100,
          postsCompleted: successes,
          postsTarget: targetSuccesses,
          lastComment: aiComment.slice(0, 50) + '...',
          commentSuccess: true
        });
              
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

    return { ok: false, message: 'Unknown action' };

  } catch (error) {
    console.error('Error in runAction:', error);
    return { ok: false, message: error.message };
  } finally {
    // Clean up browser resources
    if (!headful) {
      try {
        if (browser && platformContexts.size === 0) {
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