// utils/threadsHasMyComment.js
import fs from "fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_PATH = path.join(__dirname, "threads-commented-posts.json");

// cross-runtime sleep
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// ---------- cache helpers ----------
function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) return new Set();
  try {
    const arr = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
function saveCache(set) {
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify([...set], null, 2)); } catch {}
}
let MEM_CACHE = loadCache();

export function clearThreadsCommentCache() {
  console.log('🗑️ Clearing Threads comment cache...');
  MEM_CACHE = new Set();
  try { 
    fs.unlinkSync(CACHE_PATH); 
    console.log('✅ Comment cache file deleted');
  } catch (error) {
    console.log('⚠️ Could not delete cache file:', error.message);
  }
  console.log('✅ Comment cache cleared');
}
export function getThreadsCommentCacheStats() {
  return {
    size: MEM_CACHE.size,
    entries: [...MEM_CACHE].slice(0, 100),
    path: CACHE_PATH,
  };
}

// ---------- utils ----------
function getThreadsPostId(url) {
  try {
    const urlObj = new URL(url);
    // Threads URLs are like: https://www.threads.net/@username/post/ABC123
    const pathParts = urlObj.pathname.split('/').filter(Boolean);
    
    if (pathParts.length >= 3 && pathParts[1] === 'post') {
      const postId = pathParts[2].toLowerCase();
      return postId;
    }
    
    // Fallback: use the full pathname as ID
    const fallbackId = urlObj.pathname.toLowerCase();
    return fallbackId;
  } catch (error) {
    const fallbackId = String(url).toLowerCase();
    return fallbackId;
  }
}

async function getLoggedInThreadsHandle(page) {
  console.log('🔍 Attempting to detect logged-in Threads handle...');
  
  // Try to get handle from current page navigation
  const handleFromPage = await page.evaluate(() => {
    const results = {
      navLinks: [],
      profileImages: [],
      foundHandle: null,
      currentUrl: window.location.href
    };
    
    // Look for profile links in navigation
    const anchors = Array.from(document.querySelectorAll('nav a[href^="/@"], a[href^="/@"]'));
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      results.navLinks.push(href);
      const match = href.match(/^\/@([a-z0-9._]+)\/?$/i);
      if (match) {
        results.foundHandle = match[1];
        return results;
      }
    }
    
    // Look for profile pictures with username info
    const allProfilePics = Array.from(document.querySelectorAll('img[alt*="profile"], img[src*="profile"]'));
    results.profileImages = allProfilePics.map(img => ({
      alt: img.getAttribute('alt') || '',
      src: img.src || '',
      inNav: !!img.closest('nav'),
      inHeader: !!img.closest('header')
    }));
    
    // Look for username in profile picture alt text
    for (const img of results.profileImages) {
      if (img.inNav || img.inHeader) {
        const match = img.alt.match(/([a-z0-9._]+)'s profile/i);
        if (match) {
          results.foundHandle = match[1];
          return results;
        }
      }
    }
    
    return results;
  });
  
  console.log(`🔍 Threads handle detection from page:`, handleFromPage);

  if (handleFromPage.foundHandle) {
    console.log(`✅ Found handle: ${handleFromPage.foundHandle}`);
    return handleFromPage.foundHandle;
  }

  throw new Error("Could not determine logged-in Threads handle");
}

async function findMyCommentOnThreadsPost(page, handle) {
  console.log(`🔍 Scanning for comments by handle: ${handle}`);
  
  return await page.evaluate((handle) => {
    const results = {
      found: false,
      checked: 0,
      matched: 0,
      reason: "no-match",
      debug: {
        containers: [],
        commentElements: [],
        userLinks: [],
        matches: []
      }
    };
    
    // Try different selectors for the main post container - Threads specific
    const articleSelectors = [
      'main', // Threads uses main as primary container
      '[role="main"]',
      'div[data-pressable-container="true"]', // Threads specific
      'body', // Fallback to entire page
      'article',
      'main article', 
      '[role="main"] article',
      'div[data-testid*="thread"]'
    ];
    
    let container = null;
    for (const selector of articleSelectors) {
      const el = document.querySelector(selector);
      if (el && !container) {
        container = el;
        results.debug.containers.push(selector);
      }
    }
    
    if (!container) {
      results.reason = "no-container";
      return results;
    }

    // Look for comment-like structures in Threads - more comprehensive
    const commentSelectors = [
      'div[dir="auto"]', // Primary text containers in Threads
      'span[dir="auto"]', // Alternative text containers
      'div[role="button"]', // Interactive elements
      'a[href*="/@"]', // User links (most reliable for finding comments)
      'div[data-testid*="comment"]',
      'div[data-testid*="reply"]',
      'div', // Broad fallback
      'span' // Text elements
    ];
    
    let commentElements = [];
    for (const selector of commentSelectors) {
      const elements = Array.from(container.querySelectorAll(selector));
      
      // Filter elements that look like comments - more flexible for Threads
      const potentialComments = elements.filter(el => {
        const text = el.textContent && el.textContent.trim();
        const hasText = text && text.length > 5; // More lenient text requirement
        
        // Check if this element or nearby elements have user links
        const hasUserLink = el.querySelector('a[href*="@"]') || 
                           el.querySelector('a[href^="/@"]') ||
                           el.closest('div')?.querySelector('a[href*="@"]') ||
                           el.parentElement?.querySelector('a[href*="@"]');
        
        // Also check if the element itself is a user link
        const isUserLink = el.tagName === 'A' && (el.href.includes('@') || el.href.includes('/@'));
        
        return (hasText && hasUserLink) || isUserLink;
      });
      
      if (potentialComments.length > commentElements.length) {
        commentElements = potentialComments;
      }
    }
    
    results.debug.commentElements = commentElements.length;
    
    let matched = 0;
    
    for (let i = 0; i < Math.min(commentElements.length, 20); i++) {
      const element = commentElements[i];
      
      // Look for username links in various formats
      const linkSelectors = [
        `a[href="/@${handle}"]`,
        `a[href="/@${handle}/"]`, 
        `a[href*="@${handle}"]`,
        'a[href^="/@"]'
      ];
      
      let userLink = null;
      let isMatch = false;
      
      for (const linkSel of linkSelectors) {
        const linkEl = element.querySelector(linkSel);
        if (linkEl) {
          userLink = linkEl;
          const href = linkEl.getAttribute('href') || '';
          
          // Check if this link matches our handle
          const match = href.match(/\/@([a-z0-9._]+)/i);
          if (match && match[1].toLowerCase() === handle.toLowerCase()) {
            isMatch = true;
            results.debug.matches.push({
              href: href,
              handle: match[1],
              text: element.textContent?.trim().slice(0, 100)
            });
            break;
          }
        }
      }
      
      if (isMatch) {
        matched++;
      }
    }
    
    // If no matches found with structured approach, try a simple page-wide search
    if (matched === 0) {
      // Look for any links to the user anywhere on the page
      const allUserLinks = document.querySelectorAll(`a[href*="/@${handle}"], a[href*="@${handle}"]`);
      results.debug.userLinks = allUserLinks.length;
      
      // Check if any of these links appear to be in comment contexts
      for (const link of allUserLinks) {
        const parentText = link.closest('div, span, li')?.textContent || '';
        if (parentText.length > 20) { // Likely a comment if there's substantial text
          matched++;
          results.debug.matches.push({
            href: link.href,
            handle: handle,
            text: parentText.slice(0, 100)
          });
        }
      }
    }

    results.found = matched > 0;
    results.checked = commentElements.length;
    results.matched = matched;
    results.reason = matched ? "match" : "no-match";
    
    return results;
  }, handle);
}

async function expandThreadsComments(page, handle) {
  console.log(`🔍 Expanding comments to check for existing comment by: ${handle}`);
  
  // Quick check if we can already see our comment
  let result = await findMyCommentOnThreadsPost(page, handle);
  console.log(`🔍 Initial scan result:`, result);
  
  if (result.found) {
    console.log(`✅ Found existing comment by ${handle}`);
    return true;
  }
  
  // Light scroll to trigger lazy loading (safer than clicking buttons)
  console.log(`🔍 Scrolling to load more comments...`);
  await page.evaluate(() => {
    window.scrollBy(0, 300);
  });
  await sleep(500);
  
  // One more scroll
  await page.evaluate(() => {
    window.scrollBy(0, 300);
  });
  await sleep(500);
  
  // Final check after scrolling
  result = await findMyCommentOnThreadsPost(page, handle);
  console.log(`🔍 Final scan result after scrolling:`, result);
  
  return result.found;
}

// ---------- main API ----------
export async function hasMyThreadsCommentAndCache({
  page,
  username,
  postUrl,
  markCommented = false,
}) {
  const postId = getThreadsPostId(postUrl);
  console.log(`🔍 Checking for existing comment on post: ${postId}`);
  
  if (MEM_CACHE.has(postId)) {
    console.log(`✅ Found in cache: Already commented on ${postId}`);
    return true;
  }

  // Only navigate if we're not already on the post page
  const currentUrl = page.url();
  if (!currentUrl.includes(postId)) {
    console.log(`🔍 Navigating to post: ${postUrl}`);
    await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 10000 });
    await sleep(2000); // Give Threads time to load
  }

  let handle = null;
  
  if (username && username.trim()) {
    handle = username.trim();
    console.log(`🔍 Using provided username: ${handle}`);
  } else {
    try {
      handle = await getLoggedInThreadsHandle(page);
      console.log(`🔍 Detected handle from page: ${handle}`);
    } catch (error) {
      console.log(`❌ Could not detect handle: ${error.message}`);
      handle = null;
    }
  }
  
  if (!handle) {
    console.log(`⚠️ No handle available, marking as commented to prevent duplicates`);
    if (markCommented) { 
      MEM_CACHE.add(postId); 
      saveCache(MEM_CACHE);
    }
    return false;
  }

  const found = await expandThreadsComments(page, handle);
  
  if (found || markCommented) {
    console.log(`💾 Adding to cache: ${postId}`);
    MEM_CACHE.add(postId);
    saveCache(MEM_CACHE);
  }
  
  console.log(`🔍 Final result: ${found ? 'Found existing comment' : 'No existing comment found'}`);
  return found;
}

// Check if post is already liked (simpler check)
export async function hasMyThreadsLike(page, username) {
  
  return await page.evaluate(() => {
    // Look for filled/active heart icons or "Unlike" buttons
    const likeIndicators = [
      'svg[aria-label*="Unlike"]',
      'button[aria-label*="Unlike"]',
      'div[role="button"][aria-label*="Unlike"]',
      'svg[fill="#ed4956"]', // Instagram red heart color
      'svg[fill="red"]',
      'svg[color="red"]'
    ];
    
    for (const selector of likeIndicators) {
      const element = document.querySelector(selector);
      if (element) {
        console.log(`✅ Found like indicator: ${selector}`);
        return true;
      }
    }
    
    console.log(`❌ No like indicators found`);
    return false;
  });
}
