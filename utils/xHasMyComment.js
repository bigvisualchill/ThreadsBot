import fs from 'fs';
import path from 'path';

// cross-runtime sleep (works in any Puppeteer version)
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// Cache file for X commented posts
const X_CACHE_FILE = path.join(process.cwd(), 'utils', 'x-commented-posts.json');

// Load cache from file
function loadCache() {
  try {
    if (fs.existsSync(X_CACHE_FILE)) {
      const data = fs.readFileSync(X_CACHE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.log('Error loading X comment cache:', error.message);
  }
  return [];
}

// Save cache to file
function saveCache(cache) {
  try {
    fs.writeFileSync(X_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (error) {
    console.log('Error saving X comment cache:', error.message);
  }
}

// Clear all cache entries
function clearXCommentCache() {
  try {
    const emptyCache = [];
    saveCache(emptyCache);
    console.log('✅ X comment cache cleared');
    return true;
  } catch (error) {
    console.log('Error clearing X comment cache:', error.message);
    return false;
  }
}

// Get cache statistics
function getCacheStats() {
  const cache = loadCache();
  return {
    total: cache.length,
    entries: cache.map(entry => ({
      tweetId: entry.tweetId,
      url: entry.url,
      timestamp: entry.timestamp,
      reason: entry.reason
    }))
  };
}

// Extract tweet ID from URL
function getTweetIdFromUrl(tweetUrl) {
  try {
    const match = tweetUrl.match(/\/status\/(\d+)/);
    return match ? match[1] : null;
  } catch (error) {
    console.log('Error extracting tweet ID from URL:', error.message);
    return null;
  }
}

// Check if we've already commented on this tweet (cache check)
function hasCommentedInCache(tweetUrl) {
  const tweetId = getTweetIdFromUrl(tweetUrl);
  if (!tweetId) return false;
  
  const cache = loadCache();
  return cache.some(entry => entry.tweetId === tweetId);
}

// Add tweet to commented cache
function addToCommentedCache(tweetUrl, reason = 'commented') {
  const tweetId = getTweetIdFromUrl(tweetUrl);
  if (!tweetId) return;
  
  const cache = loadCache();
  
  // Check if already exists
  if (!cache.some(entry => entry.tweetId === tweetId)) {
    cache.push({
      tweetId,
      url: tweetUrl,
      timestamp: new Date().toISOString(),
      reason
    });
    saveCache(cache);
    console.log(`✅ Added tweet ${tweetId} to X comment cache`);
  }
}

// Check if tweet is already liked (DOM analysis)
async function isTweetAlreadyLiked(page) {
  try {
    const isLiked = await page.evaluate(() => {
      // Check for "unlike" button which indicates already liked
      const unlikeButton = document.querySelector('[data-testid="unlike"]');
      if (unlikeButton) {
        console.log('🐦 Tweet already liked (found unlike button)');
        return true;
      }
      
      // Check for filled heart icon
      const likeButton = document.querySelector('[data-testid="like"]');
      if (likeButton) {
        const svg = likeButton.querySelector('svg');
        if (svg) {
          // Check if the heart is filled (liked state)
          const path = svg.querySelector('path');
          if (path) {
            const fillColor = window.getComputedStyle(path).fill;
            const isRed = fillColor.includes('rgb(249, 24, 128)') || // X red color
                         fillColor.includes('#f91880') ||
                         fillColor !== 'none' && !fillColor.includes('currentColor');
            if (isRed) {
              console.log('🐦 Tweet already liked (heart is filled)');
              return true;
            }
          }
        }
      }
      
      return false;
    });
    
    return isLiked;
  } catch (error) {
    console.log('Error checking like status:', error.message);
    return false;
  }
}

// Get current user handle from page
async function getCurrentUserHandle(page) {
  try {
    const handle = await page.evaluate(() => {
      console.log('🐦 Attempting to find user handle...');
      
      // Try to find user handle from profile menu or navigation
      const profileSelectors = [
        '[data-testid="SideNav_AccountSwitcher_Button"]', // Account switcher button
        '[data-testid="AppTabBar_Profile_Link"]', // Profile link in tab bar
        'a[href^="/"][data-testid*="profile"]', // Profile links
        '[data-testid="UserAvatar-Container-unknown"]' // Avatar container
      ];
      
      for (const selector of profileSelectors) {
        const elements = document.querySelectorAll(selector);
        console.log(`🐦 Found ${elements.length} elements for selector: ${selector}`);
        
        for (const element of elements) {
          const href = element.getAttribute('href') || element.closest('a')?.getAttribute('href');
          console.log(`🐦 Checking href: ${href}`);
          
          if (href && href.startsWith('/') && href.length > 1 && !href.includes('/status/')) {
            const handle = href.substring(1).split('?')[0]; // Remove leading slash and query params
            if (handle.match(/^[a-zA-Z0-9_]+$/)) { // Valid Twitter handle format
              console.log(`🐦 Found valid handle: ${handle}`);
              return handle;
            }
          }
        }
      }
      
      // Fallback: look for any profile link in navigation
      const navLinks = document.querySelectorAll('nav a[href^="/"], aside a[href^="/"]');
      console.log(`🐦 Checking ${navLinks.length} navigation links...`);
      
      for (const link of navLinks) {
        const href = link.getAttribute('href');
        if (href && href.match(/^\/[a-zA-Z0-9_]+$/) && !href.includes('/status/') && !href.includes('/search')) {
          const handle = href.substring(1);
          console.log(`🐦 Found potential handle from nav: ${handle}`);
          return handle;
        }
      }
      
      // Last resort: check URL for profile pages
      const currentUrl = window.location.href;
      const profileMatch = currentUrl.match(/x\.com\/([a-zA-Z0-9_]+)(?:\/|$|\?)/);
      if (profileMatch && !currentUrl.includes('/status/')) {
        const handle = profileMatch[1];
        console.log(`🐦 Found handle from current URL: ${handle}`);
        return handle;
      }
      
      console.log('🐦 No handle found');
      return null;
    });
    
    console.log(`🐦 Current user handle detection result: ${handle || 'not found'}`);
    return handle;
  } catch (error) {
    console.log('Error getting current user handle:', error.message);
    return null;
  }
}

// Check if we've already commented on this tweet (DOM analysis)
async function hasMyCommentOnTweet(page, tweetUrl, knownHandle = null) {
  try {
    console.log(`🐦 Checking for existing comments on: ${tweetUrl}`);
    
    // Get current user handle - try known handle first, then detect
    let userHandle = knownHandle;
    if (!userHandle) {
      userHandle = await getCurrentUserHandle(page);
    }
    
    if (!userHandle) {
      console.log('⚠️ Could not determine current user handle');
      return { hasComment: false, reason: 'no-user-handle' };
    }
    
    console.log(`🐦 Using handle for comment detection: ${userHandle}`);
    
    // Navigate to tweet if not already there
    if (!page.url().includes(getTweetIdFromUrl(tweetUrl))) {
      await page.goto(tweetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(2000);
    }
    
    // Debug: analyze page content
    await debugPageContent(page, userHandle);
    
    // Look for existing comments by this user with enhanced detection
    const commentCheck = await page.evaluate((handle) => {
      console.log(`🐦 Looking for comments by user: ${handle}`);
      
      // Find all comment/reply containers with multiple strategies
      const articles = document.querySelectorAll('article');
      console.log(`🐦 Found ${articles.length} articles to check`);
      
      // Strategy 1: Look through all articles for user links
      for (let i = 0; i < articles.length; i++) {
        const article = articles[i];
        
        // Look for user links within this article (multiple formats)
        const userSelectors = [
          `a[href="/${handle}"]`,
          `a[href^="/${handle}?"]`,
          `a[href*="/${handle}"]`,
          `[data-testid*="${handle}"]`
        ];
        
        let foundUserInArticle = false;
        for (const selector of userSelectors) {
          try {
            const elements = article.querySelectorAll(selector);
            if (elements.length > 0) {
              console.log(`🐦 Found user ${handle} in article ${i} with selector: ${selector}`);
              foundUserInArticle = true;
              break;
            }
          } catch (e) {
            // Some selectors might not work, continue
          }
        }
        
        if (foundUserInArticle) {
          // Check if this is actually a comment/reply (not the original tweet)
          const isReply = article.querySelector('[data-testid="reply"]') ||
                         article.textContent.includes('Replying to') ||
                         article.textContent.includes('Show this thread') ||
                         i > 0; // First article is usually the original tweet
          
          if (isReply) {
            console.log(`✅ Found existing comment by ${handle} in article ${i}`);
            return { hasComment: true, reason: 'found-comment-in-article' };
          }
        }
      }
      
      // Strategy 2: Look for user mentions in tweet text content
      const tweetTexts = document.querySelectorAll('[data-testid="tweetText"], [role="article"] div[lang]');
      console.log(`🐦 Checking ${tweetTexts.length} tweet text elements for user mentions`);
      
      for (const textElement of tweetTexts) {
        const text = textElement.textContent || '';
        if (text.includes(`@${handle}`) || text.includes(handle)) {
          // Check if this is in a reply context
          const parentArticle = textElement.closest('article');
          if (parentArticle) {
            const articleIndex = Array.from(articles).indexOf(parentArticle);
            if (articleIndex > 0) { // Not the main tweet
              console.log(`✅ Found user ${handle} mentioned in reply text at article ${articleIndex}`);
              return { hasComment: true, reason: 'found-mention-in-reply' };
            }
          }
        }
      }
      
      // Strategy 3: Look for user avatar/profile images
      const avatars = document.querySelectorAll('img[src*="profile_images"], [data-testid*="UserAvatar"]');
      console.log(`🐦 Checking ${avatars.length} avatar elements`);
      
      for (const avatar of avatars) {
        const parentLink = avatar.closest('a');
        if (parentLink) {
          const href = parentLink.getAttribute('href');
          if (href && href.includes(`/${handle}`)) {
            const parentArticle = avatar.closest('article');
            if (parentArticle) {
              const articleIndex = Array.from(articles).indexOf(parentArticle);
              if (articleIndex > 0) { // Not the main tweet
                console.log(`✅ Found user ${handle} avatar in reply at article ${articleIndex}`);
                return { hasComment: true, reason: 'found-avatar-in-reply' };
              }
            }
          }
        }
      }
      
      // Strategy 4: Look in replies section specifically
      const repliesSections = document.querySelectorAll('[aria-label*="replies"], [data-testid*="replies"], section[role="region"]');
      console.log(`🐦 Checking ${repliesSections.length} replies sections`);
      
      for (const section of repliesSections) {
        const userLinksInSection = section.querySelectorAll(`a[href*="/${handle}"]`);
        if (userLinksInSection.length > 0) {
          console.log(`✅ Found existing comment by ${handle} in replies section`);
          return { hasComment: true, reason: 'found-in-replies-section' };
        }
      }
      
      console.log(`❌ No existing comments found by ${handle} using any detection strategy`);
      return { hasComment: false, reason: 'no-comment-found' };
    }, userHandle);
    
    return commentCheck;
  } catch (error) {
    console.log('Error checking for existing comments:', error.message);
    return { hasComment: false, reason: 'error', error: error.message };
  }
}

// Main function to check if we should skip this tweet
export async function xHasMyComment(page, tweetUrl, knownUsername = null) {
  try {
    console.log(`🐦 Checking if should skip tweet: ${tweetUrl}`);
    
    // 1. Check cache first
    if (hasCommentedInCache(tweetUrl)) {
      console.log('🐦 Tweet found in comment cache, skipping');
      return { skip: true, reason: 'in-cache' };
    }
    
    // 2. Check DOM for existing comments (more thorough)
    console.log('🐦 Cache miss - performing DOM analysis for existing comments...');
    const commentCheck = await hasMyCommentOnTweet(page, tweetUrl, knownUsername);
    console.log(`🐦 DOM analysis result:`, commentCheck);
    
    if (commentCheck.hasComment) {
      console.log(`🐦 Found existing comment via DOM analysis, adding to cache and skipping`);
      addToCommentedCache(tweetUrl, commentCheck.reason);
      return { skip: true, reason: commentCheck.reason };
    }
    
    console.log('✅ Tweet is safe to comment on (no existing comments found)');
    return { skip: false, reason: 'safe-to-comment' };
  } catch (error) {
    console.log('Error in xHasMyComment:', error.message);
    console.log('Error stack:', error.stack);
    // On error, allow commenting but log the issue
    return { skip: false, reason: 'error', error: error.message };
  }
}

// Debug function to inspect page content for troubleshooting
async function debugPageContent(page, handle) {
  try {
    const debug = await page.evaluate((handle) => {
      const articles = document.querySelectorAll('article');
      const info = {
        totalArticles: articles.length,
        userLinksFound: [],
        articleContents: [],
        allLinks: []
      };
      
      // Get all links on page
      const allLinks = document.querySelectorAll('a[href*="/"]');
      allLinks.forEach(link => {
        const href = link.getAttribute('href');
        if (href) {
          info.allLinks.push(href);
        }
      });
      
      // Check each article
      articles.forEach((article, i) => {
        const links = article.querySelectorAll('a[href*="/"]');
        const userLinks = [];
        links.forEach(link => {
          const href = link.getAttribute('href');
          if (href && href.includes(handle)) {
            userLinks.push(href);
          }
        });
        
        info.articleContents.push({
          index: i,
          userLinks: userLinks,
          textContent: article.textContent.slice(0, 200),
          hasReplyButton: !!article.querySelector('[data-testid="reply"]'),
          hasReplyingTo: article.textContent.includes('Replying to')
        });
        
        if (userLinks.length > 0) {
          info.userLinksFound.push(...userLinks);
        }
      });
      
      return info;
    }, handle);
    
    console.log(`🐦 DEBUG - Page content analysis for handle: ${handle}`);
    console.log(`🐦 DEBUG - Total articles: ${debug.totalArticles}`);
    console.log(`🐦 DEBUG - User links found: ${debug.userLinksFound.length}`);
    console.log(`🐦 DEBUG - User links:`, debug.userLinksFound);
    console.log(`🐦 DEBUG - Article summaries:`, debug.articleContents);
    
    return debug;
  } catch (error) {
    console.log('Error in debug function:', error.message);
    return null;
  }
}

// Export utility functions
export {
  loadCache,
  saveCache,
  clearXCommentCache,
  getCacheStats,
  getTweetIdFromUrl,
  hasCommentedInCache,
  addToCommentedCache,
  isTweetAlreadyLiked,
  getCurrentUserHandle,
  hasMyCommentOnTweet,
  debugPageContent
};

