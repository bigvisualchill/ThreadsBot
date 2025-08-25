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
  discoverThreadsPosts,
  discoverThreadsForYouPosts,
  createThreadsPost
} from './threads-functions.js';
import { hasMyThreadsCommentAndCache, clearThreadsCommentCache, getThreadsCommentCacheStats, hasMyThreadsLike } from './utils/threadsHasMyComment.js';

puppeteer.use(StealthPlugin());

// cross-runtime sleep (works in any Puppeteer version)
export const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// Text processing function to clean AI-generated content
function processAIText(text) {
  if (!text || typeof text !== 'string') {
    return text;
  }
  
  let processed = text;
  
  // Replace em dashes (—) with commas
  processed = processed.replace(/—/g, ',');
  
  // Replace en dashes (–) with commas
  processed = processed.replace(/–/g, ',');
  
  // Clean up multiple consecutive commas
  processed = processed.replace(/,+/g, ',');
  
  // Remove leading/trailing commas
  processed = processed.replace(/^,+|,+$/g, '');
  
  // Clean up spaces around commas
  processed = processed.replace(/\s*,\s*/g, ', ');
  
  console.log(`🔧 Text processed: "${text}" → "${processed}"`);
  
  return processed;
}

// Content filtering function to check if post should be skipped
async function shouldSkipPost(page, postUrl) {
  try {
    console.log(`🔍 Checking if post should be skipped: ${postUrl}`);
    
    // Navigate to the post
    await page.goto(postUrl, { waitUntil: 'networkidle2' });
    await sleep(2000); // Wait for content to load
    
    // Check for video content
    const hasVideo = await page.evaluate(() => {
      // Look for video elements
      const videoElements = document.querySelectorAll('video');
      if (videoElements.length > 0) {
        console.log(`🎥 Found ${videoElements.length} video element(s)`);
        return true;
      }
      
      // Look for video-related attributes and classes
      const videoSelectors = [
        '[data-testid*="video"]',
        '[aria-label*="video"]',
        '[class*="video"]',
        '[class*="Video"]',
        'div[role="video"]',
        'div[data-video]',
        'div[data-media-type="video"]'
      ];
      
      for (const selector of videoSelectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          console.log(`🎥 Found video content with selector: ${selector}`);
          return true;
        }
      }
      
      // Look for play button indicators
      const playButtons = document.querySelectorAll('[aria-label*="play"], [aria-label*="Play"], [data-testid*="play"]');
      if (playButtons.length > 0) {
        console.log(`🎥 Found play button(s), likely video content`);
        return true;
      }
      
      return false;
    });
    
    if (hasVideo) {
      console.log(`⏭️ SKIP: Post contains video content`);
      return { skip: true, reason: 'Video content detected' };
    }
    
    // Get post text content
    const postText = await page.evaluate(() => {
      // Look for main post content
      const contentSelectors = [
        'div[dir="auto"]',
        'span[dir="auto"]',
        'article div',
        'article span',
        '[data-testid*="post"] div',
        '[data-testid*="post"] span'
      ];
      
      let allText = '';
      for (const selector of contentSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          const text = el.textContent?.trim() || '';
          if (text.length > 10 && text.includes(' ')) {
            allText += text + ' ';
          }
        }
      }
      
      return allText.trim();
    });
    
    if (!postText) {
      console.log(`⏭️ SKIP: No text content found`);
      return { skip: true, reason: 'No text content' };
    }
    
    // Remove hashtags from word count
    const textWithoutHashtags = postText.replace(/#\w+/g, '').trim();
    
    // Count words (excluding hashtags)
    const words = textWithoutHashtags.split(/\s+/).filter(word => word.length > 0);
    const wordCount = words.length;
    
    console.log(`📝 Post text: "${postText.slice(0, 100)}..."`);
    console.log(`📝 Text without hashtags: "${textWithoutHashtags.slice(0, 100)}..."`);
    console.log(`📊 Word count (excluding hashtags): ${wordCount}`);
    
    if (wordCount < 5) {
      console.log(`⏭️ SKIP: Less than 5 words (${wordCount} words)`);
      return { skip: true, reason: `Less than 5 words (${wordCount} words)` };
    }
    
    console.log(`✅ Post passed content filter (${wordCount} words, no video)`);
    return { skip: false, reason: 'Content filter passed' };
    
  } catch (error) {
    console.log(`⚠️ Error checking post content: ${error.message}`);
    // If we can't check, don't skip the post
    return { skip: false, reason: 'Error checking content' };
  }
}

// Clean up browsers on process exit
process.on('SIGINT', async () => {
  console.log('Shutting down, cleaning up browsers...');
  await cleanupBrowser();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down, cleaning up browsers...');
  await cleanupBrowser();
  process.exit(0);
});

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

async function saveSession(page, platform, sessionName, assistantId = null) {
  try {
    await ensureSessionsDirectory();
    const { sessionPath } = getSessionFilePath(platform, sessionName);
    
    // Get all cookies from the page
    const cookies = await page.cookies();
    
    // Get localStorage and sessionStorage
    const storageData = await page.evaluate(() => {
      return {
        localStorage: Object.fromEntries(
          Object.entries(localStorage).map(([key, value]) => [key, value])
        ),
        sessionStorage: Object.fromEntries(
          Object.entries(sessionStorage).map(([key, value]) => [key, value])
        )
      };
    });
    
    const sessionData = {
      platform,
      timestamp: new Date().toISOString(),
      cookies: cookies,
      localStorage: storageData.localStorage,
      sessionStorage: storageData.sessionStorage,
      assistantId: assistantId // Save the assistant ID
    };
    
    await fs.writeFile(sessionPath, JSON.stringify(sessionData, null, 2));
    console.log(`✅ Session saved: ${sessionPath} (${cookies.length} cookies, ${Object.keys(storageData.localStorage).length} localStorage items, assistantId: ${assistantId ? 'saved' : 'none'})`);
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
    if (sessionData.cookies && Array.isArray(sessionData.cookies)) {
      console.log(`🔄 Loading ${sessionData.cookies.length} cookies...`);
      for (const cookie of sessionData.cookies) {
        if (cookie.name && cookie.value) {
          try {
            await page.setCookie(cookie);
          } catch (cookieError) {
            console.log(`Warning: Could not set cookie ${cookie.name}: ${cookieError.message}`);
          }
        }
      }
      console.log(`✅ Cookies loaded successfully`);
    }
    
    // Set localStorage (with error handling)
    if (sessionData.localStorage) {
      try {
        await page.evaluate((localStorageData) => {
          for (const [key, value] of Object.entries(localStorageData)) {
            try {
              localStorage.setItem(key, value);
            } catch (e) {
              console.log(`Warning: Could not set localStorage item ${key}: ${e.message}`);
            }
          }
        }, sessionData.localStorage);
        console.log(`✅ localStorage loaded successfully`);
      } catch (error) {
        console.log(`Warning: Could not load localStorage: ${error.message}`);
      }
    }
    
    // Set sessionStorage (with error handling)
    if (sessionData.sessionStorage) {
      try {
        await page.evaluate((sessionStorageData) => {
          for (const [key, value] of Object.entries(sessionStorageData)) {
            try {
              sessionStorage.setItem(key, value);
            } catch (e) {
              console.log(`Warning: Could not set sessionStorage item ${key}: ${e.message}`);
            }
          }
        }, sessionData.sessionStorage);
        console.log(`✅ sessionStorage loaded successfully`);
      } catch (error) {
        console.log(`Warning: Could not load sessionStorage: ${error.message}`);
      }
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
    console.log(`🔧 DEBUG: Retrieved assistantId from session: ${sessionData.assistantId}`);
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

    // Create JSON signal for comment generation
    const commentSignal = {
      "action": "generate_comment",
      "platform": "threads",
      "content_type": "comment_on_post",
      "target_post_content": postContent
    };

    console.log('📤 Sending comment signal to assistant:', JSON.stringify(commentSignal, null, 2));

    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: JSON.stringify(commentSignal)
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
      const rawComment = lastMessage.content[0].text.value.trim();
      
      // Process the AI-generated comment
      const comment = processAIText(rawComment);
      
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

async function generateAIPost(prompt, assistantId) {
  if (!openai || !assistantId) {
    throw new Error('OpenAI client or assistant ID not available');
  }

  try {
    console.log('🤖 Generating AI post...');

    const thread = await openai.beta.threads.create();

    // Create JSON signal for post generation
    const postSignal = {
      "action": "generate_post",
      "platform": "threads",
      "content_type": "text_only"
    };

    console.log('📤 Sending post signal to assistant:', JSON.stringify(postSignal, null, 2));

    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: JSON.stringify(postSignal)
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
      const rawPost = lastMessage.content[0].text.value.trim();
      
      // Process the AI-generated post
      const post = processAIText(rawPost);
      
      console.log(`🤖 AI post generated: "${post}"`);
      return post;
    } else {
      throw new Error(`AI generation failed with status: ${runStatus.status}`);
    }
  } catch (error) {
    console.error('AI post generation error:', error);
    throw new Error(`AI post generation failed: ${error.message}`);
  }
}

async function generateAIPostWithMedia(mediaAnalysisPrompt, assistantId) {
  if (!openai || !assistantId) {
    throw new Error('OpenAI client or assistant ID not available');
  }

  try {
    console.log('🤖 Generating AI post with media analysis...');

    const thread = await openai.beta.threads.create();

    // Create JSON signal for media-based post generation
    const mediaPostSignal = {
      "action": "generate_post_with_media",
      "platform": "threads",
      "content_type": "media_with_caption"
    };

    console.log('📤 Sending media post signal to assistant:', JSON.stringify(mediaPostSignal, null, 2));
    
    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: JSON.stringify(mediaPostSignal)
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
      const rawCaption = lastMessage.content[0].text.value.trim();
      
      // Process the AI-generated caption
      const caption = processAIText(rawCaption);
      
      console.log(`🤖 AI caption generated: "${caption}"`);
      return caption;
    } else {
      throw new Error(`AI generation failed with status: ${runStatus.status}`);
    }
  } catch (error) {
    console.error('AI media post generation error:', error);
    throw new Error(`AI media post generation failed: ${error.message}`);
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
    
    // Clear browser storage using Puppeteer methods (more reliable)
    try {
      // Clear all cookies using Puppeteer
      const cookies = await page.cookies();
      for (const cookie of cookies) {
        await page.deleteCookie(cookie);
      }
      
      // Clear localStorage and sessionStorage
      await page.evaluate(() => {
        try {
          localStorage.clear();
          sessionStorage.clear();
        } catch (e) {
          console.log('Could not clear storage:', e.message);
        }
      });
      
      console.log(`Cleared ${cookies.length} cookies and storage`);
    } catch (storageError) {
      console.log(`Could not clear browser storage: ${storageError.message}`);
      // Continue with logout even if storage clearing fails
    }
    
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
    
    // If the main error was just a storage clearing issue, still consider logout successful
    if (error.message && error.message.includes('SecurityError') && error.message.includes('cookie')) {
      console.log('Storage clearing failed but session file deleted - logout successful');
      return { success: true, message: `Successfully logged out from ${platform} (session cleared)` };
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
        try {
          console.log('Reusing existing headful browser');
          // Test if the browser is still responsive
          const pages = await globalBrowser.pages();
          page = await globalBrowser.newPage();
          return { browser: globalBrowser, page };
        } catch (browserError) {
          console.log('Existing browser is not responsive, creating new one:', browserError.message);
          globalBrowser = null;
        }
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
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor',
          '--disable-extensions',
          '--disable-plugins',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-field-trial-config',
          '--disable-ipc-flooding-protection',
          '--enable-features=NetworkService,NetworkServiceLogging',
          '--force-color-profile=srgb',
          '--metrics-recording-only',
          '--no-default-browser-check',
          '--no-pings',
          '--no-zygote',
          '--password-store=basic',
          '--use-mock-keychain',
          '--window-size=1920,1080',
          '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ]
      });
      
      page = await globalBrowser.newPage();
      
      // Additional stealth measures
      await page.evaluateOnNewDocument(() => {
        // Remove webdriver property
        delete navigator.__proto__.webdriver;
        
        // Override permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
          parameters.name === 'notifications' ?
            Promise.resolve({ state: Notification.permission }) :
            originalQuery(parameters)
        );
        
        // Override plugins
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5],
        });
        
        // Override languages
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en'],
        });
        
        // Override chrome
        Object.defineProperty(window, 'chrome', {
          get: () => ({
            runtime: {},
          }),
        });
      });
      
      return { browser: globalBrowser, page };
    } else {
      // For headless mode, create isolated contexts per platform
      if (platform) {
        if (platformContexts.has(platform)) {
          try {
            // Reuse existing isolated context
            const existingContext = platformContexts.get(platform);
            page = await existingContext.context.newPage();
            return { browser: existingContext.browser, page };
          } catch (contextError) {
            console.log('Existing context is not responsive, creating new one:', contextError.message);
            platformContexts.delete(platform);
          }
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
    
    // Clean up any broken browser instances
    if (globalBrowser) {
      try {
        await globalBrowser.close();
      } catch (e) {
        console.log('Error closing broken browser:', e.message);
      }
      globalBrowser = null;
    }
    
    // Clear broken platform contexts
    if (platform) {
      platformContexts.delete(platform);
    }
    
    throw error;
  }
}

// Clean up browser resources
async function cleanupBrowser() {
  if (globalBrowser) {
    try {
      await globalBrowser.close();
      console.log('Global browser closed');
    } catch (e) {
      console.log('Error closing global browser:', e.message);
    }
    globalBrowser = null;
  }
  
  // Close all platform contexts
  for (const [platform, context] of platformContexts.entries()) {
    try {
      await context.browser.close();
      console.log(`Platform context closed: ${platform}`);
    } catch (e) {
      console.log(`Error closing platform context ${platform}:`, e.message);
    }
  }
  platformContexts.clear();
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
    useMedia = false,
    mediaFolder = '',
    progressSessionId,
    sendProgress,
  } = options;

  // Progress tracking helper
  const reportProgress = (step, details = {}) => {
    console.log(`📊 Progress: ${step}`, details);
    if (sendProgress) {
      sendProgress({
        step,
        platform,
        action,
        sessionName,
        ...details
      });
    }
  };

  let browser;
  let page;

  try {
    // Validation - only Threads platform supported
    if (!platform || platform !== 'threads') {
      throw new Error('Only Threads platform is supported');
    }
    if (!action || !['login', 'auto-comment', 'auto-post', 'check-session', 'logout'].includes(action)) {
      throw new Error('Invalid or missing action');
    }
    if (action === 'auto-comment' && !searchCriteria) {
      throw new Error('searchCriteria is required for auto-comment action');
    }
    if (action === 'auto-post' && !assistantId) {
      throw new Error('assistantId is required for auto-post action');
    }

    // Report initial progress
    reportProgress('🌐 Opening browser...', { current: 0, total: 100 });
    
    // Launch browser with platform isolation for headful mode
    let browserResult;
    try {
      browserResult = await launchBrowser(headful, platform);
      browser = browserResult.browser;
      page = browserResult.page;
    } catch (browserError) {
      console.error('Failed to launch browser, retrying once:', browserError.message);
      
      // Clean up and retry once
      await cleanupBrowser();
      await sleep(2000);
      
      browserResult = await launchBrowser(headful, platform);
      browser = browserResult.browser;
      page = browserResult.page;
    }
    
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
      
      // Try to load session (but don't fail if it doesn't work)
      try {
        await loadSession(page, platform, sessionName);
      } catch (error) {
        console.log(`Session loading failed, continuing with check: ${error.message}`);
      }
      
      // Check Threads login status
      await page.goto('https://www.threads.com/', { waitUntil: 'networkidle2' });
      
      // Wait a bit for the page to fully load
      await sleep(3000);
        
      const loginStatus = await page.evaluate(() => {
        const composeButton = document.querySelector('[aria-label*="Compose"], [data-testid*="compose"], button[aria-label*="compose" i]');
        const userMenu = document.querySelector('[aria-label*="Account"], [data-testid*="account"], [data-testid*="user"]');
        const feedIndicator = document.querySelector('[data-testid*="feed"], .feed, [aria-label*="feed"]');
        const homeIndicator = document.querySelector('[aria-label*="Home"], [data-testid*="home"]');
        const loginForm = document.querySelector('form[action*="login"], input[type="password"]');
        
        console.log('Checking login status...');
        console.log('Compose button:', !!composeButton);
        console.log('User menu:', !!userMenu);
        console.log('Feed indicator:', !!feedIndicator);
        console.log('Home indicator:', !!homeIndicator);
        console.log('Login form:', !!loginForm);
        
        // If we see login form, definitely not logged in
        if (loginForm) {
          return false;
        }
        
        // If we see authenticated elements, definitely logged in
        return !!(composeButton || userMenu || feedIndicator || homeIndicator);
      });
      
      if (loginStatus) {
        return { ok: true, message: 'Session is valid and logged in' };
      } else {
        return { ok: false, message: 'Session is invalid or expired - please login again' };
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
      await page.goto('https://www.threads.com/', { waitUntil: 'networkidle2' });
      
      // Try to login using Threads functions
      const loginSuccess = await ensureThreadsLoggedIn(page, { username, password });
      
      if (loginSuccess) {
        // Save session after successful login
        console.log(`🔧 DEBUG: Saving session with assistantId: ${assistantId}`);
        const sessionSaved = await saveSession(page, platform, sessionName, assistantId);
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
      
      // Navigate to Threads and check if already logged in
      await page.goto('https://www.threads.com/', { waitUntil: 'networkidle2' });
      await sleep(2000);
      
      // Check if already logged in
      const isLoggedIn = await page.evaluate(() => {
        // Look for login form elements
        const loginForm = document.querySelector('form[action*="login"], input[type="password"], input[placeholder*="password"]');
        
        // Look for authenticated user elements by checking page content
        const pageText = document.body.textContent || '';
        const hasCreateButton = pageText.includes('Create');
        const hasPostButton = pageText.includes('Post');
        const hasLikeButton = pageText.includes('Like');
        const hasReplyButton = pageText.includes('Reply');
        
        console.log('Login detection:');
        console.log('- Login form found:', !!loginForm);
        console.log('- Create button found:', hasCreateButton);
        console.log('- Post button found:', hasPostButton);
        console.log('- Like button found:', hasLikeButton);
        console.log('- Reply button found:', hasReplyButton);
        
        // If we see login form, not logged in
        if (loginForm) {
          console.log('Login form detected - NOT logged in');
          return false;
        }
        
        // If we see authenticated elements, logged in
        const hasAuthElements = hasCreateButton || hasPostButton || hasLikeButton || hasReplyButton;
        console.log('Has authenticated elements:', hasAuthElements);
        
        return hasAuthElements;
      });
      
      if (!isLoggedIn) {
        // Only try to login if not already logged in
        console.log('Not logged in, attempting login...');
        await ensureThreadsLoggedIn(page, { username, password });
      } else {
        console.log('Already logged in, proceeding with search...');
      }
      
      reportProgress('🔍 Discovering posts...', { current: 30, total: 100 });
      
      // Parse search criteria
      let parsedCriteria;
      if (typeof searchCriteria === 'string') {
        // Legacy format support
        parsedCriteria = searchCriteria.startsWith('#') 
          ? { hashtag: searchCriteria } 
          : { keywords: searchCriteria };
      } else {
        // New format with source parameter
        if (searchCriteria.source === 'search' && searchCriteria.searchTerm) {
          parsedCriteria = { keywords: searchCriteria.searchTerm };
        } else {
          parsedCriteria = searchCriteria;
        }
      }
      
      // Discover posts based on source
      let posts;
      if (parsedCriteria.source === 'foryou') {
        // Use For You feed
        console.log('🔍 Using For You feed for post discovery');
        posts = await discoverThreadsForYouPosts(page, maxPosts + 2);
      } else {
        // Use search (default)
        console.log('🔍 Using search for post discovery');
        posts = await discoverThreadsPosts(page, parsedCriteria, maxPosts + 2);
      }
      console.log(`Found ${posts.length} Threads posts to process (target: ${maxPosts})`);
      
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
        console.log(`\n🔄 [${attempts}/${posts.length}] Processing: ${postUrl} (successes: ${successes}/${targetSuccesses})`);
        
        // Check if we've already reached our target
        if (successes >= targetSuccesses) {
          console.log(`🎯 Target already reached: ${successes}/${targetSuccesses} - skipping remaining posts`);
          break;
        }
        
        try {
          // Check if post should be skipped based on content filter
          const skipCheck = await shouldSkipPost(page, postUrl);
          if (skipCheck.skip) {
            console.log(`⏭️ SKIP: ${skipCheck.reason}`);
            results.push({ url: postUrl, success: false, error: skipCheck.reason });
            continue;
          }
          
          // Get post content for AI comment generation
          const postContent = await getPostContent(page, postUrl, platform);
          if (!postContent || postContent.length < 10) {
            console.log(`⚠️ SKIP: No substantial content found`);
            results.push({ url: postUrl, success: false, error: 'No substantial content' });
            continue;
          }
          
          // Check for duplicate comments
          const already = await hasMyThreadsCommentAndCache({ page, username, postUrl });
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
            
            // Skip if comment is empty
            if (!aiComment || aiComment.trim() === '') {
              console.log(`⏭️ SKIPPED: Empty comment - no content to post`);
              results.push({ url: postUrl, success: false, error: 'Empty comment' });
              continue;
            }

          // Post the comment
          const commentResult = await threadsComment(page, postUrl, aiComment);

            if (commentResult.skipped) {
              console.log(`⏭️ SKIPPED: ${commentResult.reason}`);
              results.push({ url: postUrl, success: false, error: commentResult.reason });
            } else {
              // Mark this post as commented to prevent future duplicates
              console.log(`💾 Marking post as commented to prevent duplicates`);
              await hasMyThreadsCommentAndCache({ page, username, postUrl, markCommented: true });
              
              // Like the post if requested
              if (likePost) {
                try {
                  console.log(`❤️ Liking post: ${postUrl}`);
                const likeResult = await threadsLike(page, postUrl);
                  if (likeResult && likeResult.success) {
                    console.log(`✅ Post liked successfully`);
                  } else {
                    console.log(`⚠️ Like may have failed (returned false or no success)`);
                  }
                } catch (likeError) {
                  console.log(`❌ Like failed: ${likeError.message}`);
                  // Don't fail the whole operation if like fails, but show the error
                }
              }
              
              results.push({ url: postUrl, success: true, comment: aiComment, liked: likePost, verified: commentResult.verified });
              successes++;
              console.log(`✅ COMPLETED: Comment posted successfully (${successes}/${targetSuccesses}) - Verified: ${commentResult.verified}`);
              
              // Report success progress
            reportProgress(`✅ Threads comment posted! (${successes}/${targetSuccesses})`, {
          current: 40 + (successes / targetSuccesses) * 50,
          total: 100,
          postsCompleted: successes,
          postsTarget: targetSuccesses,
          lastComment: aiComment.slice(0, 50) + '...',
          commentSuccess: true
        });
            }
            
            // Check if we've reached our target (moved outside the else block)
            if (successes >= targetSuccesses) {
              console.log(`🎯 Target reached: ${successes}/${targetSuccesses} comments posted - stopping`);
              break;
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

    // Handle auto-post action
    if (action === 'auto-post') {
      if (!assistantId) {
        throw new Error('Assistant ID is required for auto-posting');
      }

      // Load session first
      const sessionLoaded = await loadSession(page, platform, sessionName);
      
      // Navigate to Threads and check if already logged in
      await page.goto('https://www.threads.com/', { waitUntil: 'networkidle2' });
      await sleep(2000);
      
      // Check if already logged in
      const isLoggedIn = await page.evaluate(() => {
        const loginForm = document.querySelector('form[action*="login"], input[type="password"], input[placeholder*="password"]');
        const pageText = document.body.textContent || '';
        const hasCreateButton = pageText.includes('Create');
        const hasPostButton = pageText.includes('Post');
        const hasLikeButton = pageText.includes('Like');
        const hasReplyButton = pageText.includes('Reply');
        
        if (loginForm) {
          return false;
        }
        
        const hasAuthElements = hasCreateButton || hasPostButton || hasLikeButton || hasReplyButton;
        return hasAuthElements;
      });
      
      if (!isLoggedIn) {
        console.log('Not logged in, attempting login...');
        await ensureThreadsLoggedIn(page, { username, password });
      } else {
        console.log('Already logged in, proceeding with posting...');
      }
      
      reportProgress('🤖 Generating AI content...', { current: 30, total: 100 });
      
      // Generate AI content for the post
      let postContent;
      let mediaFiles = [];
      
      if (useMedia && mediaFolder) {
        // Handle media-based posting
        try {
          // Get media files from the folder
          const fs = await import('fs/promises');
          const path = await import('path');
          
          const mediaFilesList = await fs.readdir(mediaFolder);
          const supportedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.mp4', '.mov'];
          
          mediaFiles = mediaFilesList
            .filter(file => supportedExtensions.includes(path.extname(file).toLowerCase()))
            .map(file => path.join(mediaFolder, file));
          
          if (mediaFiles.length === 0) {
            throw new Error('No supported media files found in the specified folder');
          }
          
          // Select a random media file
          const selectedMedia = mediaFiles[Math.floor(Math.random() * mediaFiles.length)];
          const mediaFileName = path.basename(selectedMedia);
          
          console.log(`📸 Using media file: ${mediaFileName}`);
          
          // Create a JSON signal for the AI to analyze the media
          const mediaAnalysisPrompt = {
            type: 'media_analysis',
            mediaFile: selectedMedia,
            fileName: mediaFileName
          };
          
          // Generate caption based on media
          postContent = await generateAIPostWithMedia(mediaAnalysisPrompt, assistantId);
          
        } catch (error) {
          console.error('Error handling media:', error);
          throw new Error(`Media processing failed: ${error.message}`);
        }
              } else {
          // Handle text-only posting
          postContent = await generateAIPost('', assistantId);
        }
      
      if (!postContent || postContent.trim().length === 0) {
        throw new Error('Failed to generate post content');
      }
      
      console.log(`📝 Generated post content: "${postContent}"`);
      
      reportProgress('📤 Creating post...', { current: 60, total: 100 });
      
      // Create the post
      const postResult = await createThreadsPost(page, postContent, mediaFiles);
      
      if (postResult.success) {
        reportProgress('✅ Post created successfully!', { current: 100, total: 100 });
        return {
          ok: true,
          message: `Post created successfully: "${postContent.slice(0, 100)}..."`,
          postContent: postContent,
          mediaUsed: mediaFiles.length > 0 ? mediaFiles.length : 0
        };
      } else {
        throw new Error(`Failed to create post: ${postResult.error || 'Unknown error'}`);
      }
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