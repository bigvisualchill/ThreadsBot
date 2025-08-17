import fs from 'fs';
import path from 'path';

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
      // Try to find user handle from profile menu or navigation
      const profileSelectors = [
        '[data-testid="SideNav_AccountSwitcher_Button"] [data-testid="UserAvatar-Container-unknown"]',
        '[data-testid="AppTabBar_Profile_Link"]',
        'a[href^="/"][data-testid*="profile"]'
      ];
      
      for (const selector of profileSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          const href = element.getAttribute('href');
          if (href && href.startsWith('/') && href.length > 1) {
            return href.substring(1); // Remove leading slash
          }
        }
      }
      
      // Fallback: look for any profile link in navigation
      const navLinks = document.querySelectorAll('nav a[href^="/"]');
      for (const link of navLinks) {
        const href = link.getAttribute('href');
        if (href && href.match(/^\/\w+$/) && !href.includes('/')) {
          return href.substring(1);
        }
      }
      
      return null;
    });
    
    console.log(`🐦 Current user handle: ${handle || 'not found'}`);
    return handle;
  } catch (error) {
    console.log('Error getting current user handle:', error.message);
    return null;
  }
}

// Check if we've already commented on this tweet (DOM analysis)
async function hasMyCommentOnTweet(page, tweetUrl) {
  try {
    console.log(`🐦 Checking for existing comments on: ${tweetUrl}`);
    
    // Get current user handle
    const userHandle = await getCurrentUserHandle(page);
    if (!userHandle) {
      console.log('⚠️ Could not determine current user handle');
      return { hasComment: false, reason: 'no-user-handle' };
    }
    
    // Navigate to tweet if not already there
    if (!page.url().includes(getTweetIdFromUrl(tweetUrl))) {
      await page.goto(tweetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(2000);
    }
    
    // Look for existing comments by this user
    const commentCheck = await page.evaluate((handle) => {
      console.log(`🐦 Looking for comments by user: ${handle}`);
      
      // Find all comment/reply containers
      const articles = document.querySelectorAll('article');
      console.log(`🐦 Found ${articles.length} articles to check`);
      
      for (let i = 0; i < articles.length; i++) {
        const article = articles[i];
        
        // Look for user links within this article
        const userLinks = article.querySelectorAll(`a[href="/${handle}"], a[href^="/${handle}?"]`);
        
        if (userLinks.length > 0) {
          // Check if this is actually a comment/reply (not the original tweet)
          const isReply = article.querySelector('[data-testid="reply"]') ||
                         article.textContent.includes('Replying to') ||
                         i > 0; // First article is usually the original tweet
          
          if (isReply) {
            console.log(`✅ Found existing comment by ${handle} in article ${i}`);
            return { hasComment: true, reason: 'found-comment' };
          }
        }
      }
      
      // Also check for any replies section
      const repliesSection = document.querySelector('[aria-label*="replies"]') || 
                            document.querySelector('[data-testid*="replies"]');
      
      if (repliesSection) {
        const userLinksInReplies = repliesSection.querySelectorAll(`a[href="/${handle}"]`);
        if (userLinksInReplies.length > 0) {
          console.log(`✅ Found existing comment by ${handle} in replies section`);
          return { hasComment: true, reason: 'found-in-replies' };
        }
      }
      
      console.log(`❌ No existing comments found by ${handle}`);
      return { hasComment: false, reason: 'no-comment-found' };
    }, userHandle);
    
    return commentCheck;
  } catch (error) {
    console.log('Error checking for existing comments:', error.message);
    return { hasComment: false, reason: 'error', error: error.message };
  }
}

// Main function to check if we should skip this tweet
export async function xHasMyComment(page, tweetUrl) {
  try {
    console.log(`🐦 Checking if should skip tweet: ${tweetUrl}`);
    
    // 1. Check cache first
    if (hasCommentedInCache(tweetUrl)) {
      console.log('🐦 Tweet found in comment cache, skipping');
      return { skip: true, reason: 'in-cache' };
    }
    
    // 2. Check DOM for existing comments
    const commentCheck = await hasMyCommentOnTweet(page, tweetUrl);
    if (commentCheck.hasComment) {
      console.log(`🐦 Found existing comment, adding to cache and skipping`);
      addToCommentedCache(tweetUrl, commentCheck.reason);
      return { skip: true, reason: commentCheck.reason };
    }
    
    console.log('✅ Tweet is safe to comment on');
    return { skip: false, reason: 'safe-to-comment' };
  } catch (error) {
    console.log('Error in xHasMyComment:', error.message);
    return { skip: false, reason: 'error', error: error.message };
  }
}

// Export utility functions
export {
  loadCache,
  saveCache,
  getCacheStats,
  getTweetIdFromUrl,
  hasCommentedInCache,
  addToCommentedCache,
  isTweetAlreadyLiked,
  getCurrentUserHandle,
  hasMyCommentOnTweet
};
