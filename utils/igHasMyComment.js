// utils/igHasMyComment.js
import fs from "fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_PATH = path.join(__dirname, "commented-posts.json");

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

export function clearCommentCache() {
  MEM_CACHE = new Set();
  try { fs.unlinkSync(CACHE_PATH); } catch {}
}
export function getCommentCacheStats() {
  return {
    size: MEM_CACHE.size,
    entries: [...MEM_CACHE].slice(0, 100),
    path: CACHE_PATH,
  };
}

// Debug function to test comment detection on current page
export async function debugCommentDetection(page, username) {
  console.log('🔧 DEBUG: Starting comment detection test...');
  
  const currentUrl = page.url();
  console.log(`🔧 DEBUG: Current URL: ${currentUrl}`);
  
  // Get handle
  let handle = null;
  try {
    handle = await getLoggedInHandle(page);
    console.log(`🔧 DEBUG: Resolved handle: ${handle}`);
  } catch (error) {
    console.log(`🔧 DEBUG: Could not resolve handle, using provided username: ${username}`);
    handle = (username || "").trim();
  }
  
  if (!handle) {
    console.log('🔧 DEBUG: No handle available');
    return { error: 'No handle available' };
  }
  
  // Comprehensive DOM analysis
  const domAnalysis = await page.evaluate(() => {
    const analysis = {
      pageStructure: {},
      commentElements: {},
      allLinks: []
    };
    
    // Analyze page structure
    analysis.pageStructure = {
      hasMain: !!document.querySelector('main'),
      hasArticle: !!document.querySelector('article'),
      hasRoleMain: !!document.querySelector('[role="main"]'),
      hasSection: !!document.querySelector('section'),
      totalElements: document.querySelectorAll('*').length
    };
    
    // Find all comment-like structures
    const commentContainers = document.querySelectorAll('ul, ol, div[role="list"]');
    analysis.commentElements = {
      totalContainers: commentContainers.length,
      containersWithLis: 0,
      totalLis: 0
    };
    
    commentContainers.forEach(container => {
      const lis = container.querySelectorAll('li');
      if (lis.length > 0) {
        analysis.commentElements.containersWithLis++;
        analysis.commentElements.totalLis += lis.length;
      }
    });
    
    // Get all user links (potential comment authors)
    const allLinks = Array.from(document.querySelectorAll('a[href^="/"]'));
    analysis.allLinks = allLinks.map(a => ({
      href: a.getAttribute('href'),
      text: a.textContent?.trim() || '',
      hasImage: !!a.querySelector('img')
    })).filter(link => link.href.match(/^\/[a-z0-9._]+\/?$/i));
    
    return analysis;
  });
  
  console.log('🔧 DEBUG: DOM Analysis:', JSON.stringify(domAnalysis, null, 2));
  
  // Test comment finding
  const result = await findMyCommentOnPage(page, handle);
  console.log('🔧 DEBUG: Comment detection result:', JSON.stringify(result, null, 2));
  
  return { ...result, domAnalysis };
}

// ---------- utils ----------
function normalizePathLower(p) {
  try {
    const url = new URL(p, "https://www.instagram.com");
    let pathname = url.pathname || "/";
    pathname = decodeURIComponent(pathname);
    pathname = pathname.replace(/\/+/g, "/");
    if (!pathname.endsWith("/")) pathname += "/";
    return pathname.toLowerCase();
  } catch {
    let pathname = String(p || "/");
    pathname = pathname.replace(/\/+/g, "/");
    if (!pathname.endsWith("/")) pathname += "/";
    return pathname.toLowerCase();
  }
}
function getShortcodeFromUrl(u) {
  try {
    const url = new URL(u);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && ["p", "reel", "tv"].includes(parts[0])) return parts[1].toLowerCase();
    return normalizePathLower(url.pathname);
  } catch {
    return String(u).toLowerCase();
  }
}

let CACHED_HANDLE = null;
async function getLoggedInHandle(page) {
  if (CACHED_HANDLE) return CACHED_HANDLE;

  // Try to get handle from current page first (avoid navigation)
  const handleFromPage = await page.evaluate(() => {
    const results = {
      navLinks: [],
      profileImages: [],
      foundHandle: null,
      currentUrl: window.location.href
    };
    
    // Look for profile links in navigation (most reliable for logged-in user)
    const anchors = Array.from(document.querySelectorAll('nav a[href^="/"]'));
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      results.navLinks.push(href);
      const m = href.match(/^\/([a-z0-9._]+)\/$/i);
      if (m && !["explore", "accounts", "reels", "direct"].includes(m[1].toLowerCase())) {
        // This is likely the logged-in user's profile link in navigation
        results.foundHandle = m[1];
        return results;
      }
    }
    
    // Look for ALL profile pictures to see what we're dealing with
    const allProfilePics = Array.from(document.querySelectorAll('img[alt*="profile picture"]'));
    results.profileImages = allProfilePics.map(img => ({
      alt: img.getAttribute('alt') || '',
      src: img.src || '',
      inNav: !!img.closest('nav'),
      inHeader: !!img.closest('header'),
      isFirst: img === allProfilePics[0]
    }));
    
    // Only use profile picture if it's in navigation/header (more likely to be the logged-in user)
    for (const img of results.profileImages) {
      if (img.inNav || img.inHeader) {
        const match = img.alt.match(/([a-z0-9._]+)'s profile picture/i);
        if (match) {
          results.foundHandle = match[1];
          return results;
        }
      }
    }
    
    return results;
  });
  
  console.log(`🔍 Handle detection from page:`, handleFromPage);

  if (handleFromPage.foundHandle) {
    CACHED_HANDLE = handleFromPage.foundHandle;
    return CACHED_HANDLE;
  }

  // Only navigate to edit page as last resort
  const prev = page.url();
  try {
    await page.goto("https://www.instagram.com/accounts/edit/", { waitUntil: "domcontentloaded", timeout: 10000 });
    await page.waitForSelector('input[name="username"]', { timeout: 8000 });
    const handle = await page.$eval('input[name="username"]', el => (el.value || "").trim());
    if (handle) {
      CACHED_HANDLE = handle;
      // Navigate back quickly
      if (/^https?:\/\/(www\.)?instagram\.com/.test(prev)) {
        await page.goto(prev, { waitUntil: "domcontentloaded" }).catch(() => {});
      }
      return CACHED_HANDLE;
    }
  } catch (error) {
    console.log("Failed to get handle from edit page, using fallback");
  }
  
  throw new Error("Could not determine logged-in handle");
}

async function expandCommentsEfficiently(page, handle) {
  const handlePath = normalizePathLower(`/${handle}/`);
  
  // Quick check if we can already see our comment without expanding
  let result = await findMyCommentOnPage(page, handle);
  console.log(`🔍 Initial check result:`, result);
  if (result.found) return true;
  
  // Expand main comments first (most likely to contain our comment)
  for (let i = 0; i < 5; i++) {
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button,a")).filter(el => {
        const t = (el.textContent || "").toLowerCase();
        return (t.includes("view all") || t.includes("view more") || t.includes("load more") || t.includes("show more")) && t.includes("comment");
      });
      if (btns.length) { btns[0].click(); return true; }
      return false;
    });
    if (!clicked) break;
    console.log(`🔄 Expanded main comments (iteration ${i + 1})`);
    await sleep(150);
    
    // Check after each expansion if we found our comment
    result = await findMyCommentOnPage(page, handle);
    console.log(`🔍 After main expansion ${i + 1}:`, { found: result.found, checked: result.checked, matched: result.matched });
    if (result.found) return true;
  }
  
  // Only expand replies if we haven't found our comment yet
  for (let i = 0; i < 8; i++) {
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(el => /view replies/i.test(el.textContent || ""));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!clicked) break;
    console.log(`🔄 Expanded replies (iteration ${i + 1})`);
    await sleep(100);
    
    // Check after expanding replies
    result = await findMyCommentOnPage(page, handle);
    console.log(`🔍 After reply expansion ${i + 1}:`, { found: result.found, checked: result.checked, matched: result.matched });
    if (result.found) return true;
  }
  
  // Light scroll to trigger any lazy loading
  await page.evaluate(() => {
    const article = document.querySelector("article");
    if (article) article.scrollIntoView({ behavior: "smooth", block: "end" });
  });
  await sleep(150);
  
  // Final check with full debug info
  result = await findMyCommentOnPage(page, handle);
  console.log(`🔍 Final check result:`, result);
  
  return result.found;
}

// Alternative comment search method - searches entire page for user links
async function alternativeCommentSearch(page, handle) {
  const handlePath = normalizePathLower(`/${handle}/`);
  console.log(`🔍 ALTERNATIVE: Searching entire page for handle: ${handlePath}`);
  
  return await page.evaluate((handlePath) => {
    function normPath(href) {
      try {
        const u = new URL(href, "https://www.instagram.com");
        let p = decodeURIComponent(u.pathname || "/");
        p = p.replace(/\/+/g, "/");
        if (!p.endsWith("/")) p += "/";
        return p.toLowerCase();
      } catch { return ""; }
    }

    // Search entire page for any links to the user
    const allLinks = Array.from(document.querySelectorAll('a[href^="/"]'));
    let matched = 0;
    const matches = [];
    
    for (const link of allLinks) {
      const href = link.getAttribute("href") || "";
      const normalizedHref = normPath(href);
      
      if (normalizedHref === handlePath) {
        // Check if this link appears to be in a comment context
        const parent = link.closest('li, div, span');
        const hasCommentText = parent && parent.textContent && parent.textContent.trim().length > 10;
        
        if (hasCommentText) {
          matched++;
          matches.push({
            href: href,
            text: parent.textContent.slice(0, 100),
            context: parent.tagName.toLowerCase()
          });
        }
      }
    }
    
    console.log(`🔍 ALTERNATIVE: Found ${matched} potential comment links`);
    if (matches.length > 0) {
      console.log(`🔍 ALTERNATIVE: Sample matches:`, matches.slice(0, 3));
    }
    
    return matched > 0;
  }, handlePath);
}

async function findMyCommentOnPage(page, handle) {
  const handlePath = normalizePathLower(`/${handle}/`);
  console.log(`🔍 Looking for comments from handle path: ${handlePath}`);
  
  return await page.evaluate((handlePath) => {
    function normPath(href) {
      try {
        const u = new URL(href, "https://www.instagram.com");
        let p = decodeURIComponent(u.pathname || "/");
        p = p.replace(/\/+/g, "/");
        if (!p.endsWith("/")) p += "/";
        return p.toLowerCase();
      } catch { return ""; }
    }

    const debugInfo = {
      articleSelectors: [],
      foundArticle: null,
      commentSelectors: [],
      totalLis: 0,
      commentDetails: [],
      lookingFor: handlePath
    };

    // Try different article selectors - be more comprehensive
    const articleSelectors = [
      'div[role="dialog"] article',
      'main article', 
      'article',
      '[role="main"] article',
      'section article',
      'main section article',
      '[role="main"] section article',
      'div[role="main"] article',
      'section[role="main"] article'
    ];
    
    let article = null;
    for (const selector of articleSelectors) {
      const el = document.querySelector(selector);
      debugInfo.articleSelectors.push({ selector, found: !!el });
      if (el && !article) {
        article = el;
        debugInfo.foundArticle = selector;
      }
    }
    
    if (!article) {
      // Fallback: try to find comments anywhere on the page
      debugInfo.fallbackAttempt = true;
      const fallbackSelectors = [
        'main',
        '[role="main"]',
        'section',
        'div[id*="mount"]',
        'body'
      ];
      
      for (const selector of fallbackSelectors) {
        const el = document.querySelector(selector);
        if (el && el.querySelector('ul li')) {
          article = el;
          debugInfo.foundArticle = `fallback:${selector}`;
          break;
        }
      }
      
      if (!article) {
        return { 
          found: false, 
          checked: 0, 
          matched: 0, 
          reason: "no-article-or-fallback",
          debugInfo 
        };
      }
    }

    // Try different comment list selectors
    const commentSelectors = [
      "ul li",
      "div ul li", 
      "[role=\"button\"] + ul li",
      "article ul li"
    ];
    
    let lis = [];
    for (const selector of commentSelectors) {
      const elements = Array.from(article.querySelectorAll(selector));
      debugInfo.commentSelectors.push({ selector, count: elements.length });
      if (elements.length > lis.length) {
        lis = elements;
      }
    }
    
    debugInfo.totalLis = lis.length;
    let matched = 0;
    
    for (let i = 0; i < Math.min(lis.length, 20); i++) {
      const li = lis[i];
      
      // Look for text content in various ways
      const textSelectors = [
        'span[dir="auto"]',
        'div[dir="auto"]', 
        'span',
        'div'
      ];
      
      let commentText = '';
      let hasText = false;
      for (const textSel of textSelectors) {
        const textEl = li.querySelector(textSel);
        if (textEl && textEl.textContent && textEl.textContent.trim()) {
          commentText = textEl.textContent.trim();
          hasText = true;
          break;
        }
      }
      
      if (!hasText) continue;
      
      // Look for username link
      const linkSelectors = [
        'a[href^="/"]',
        'a',
        '[role="link"]'
      ];
      
      let userLink = null;
      for (const linkSel of linkSelectors) {
        const linkEl = li.querySelector(linkSel);
        if (linkEl && linkEl.getAttribute('href')) {
          userLink = linkEl;
          break;
        }
      }
      
      if (!userLink) continue;
      
      const href = userLink.getAttribute("href") || "";
      const normalizedHref = normPath(href);
      const isMatch = normalizedHref === handlePath;
      
      debugInfo.commentDetails.push({
        index: i,
        href: href,
        normalized: normalizedHref,
        text: commentText.slice(0, 50),
        isMatch: isMatch,
        linkText: userLink.textContent || ''
      });
      
      if (isMatch) {
        matched++;
      }
    }
    
    return { 
      found: matched > 0, 
      checked: lis.length, 
      matched, 
      reason: matched ? "match" : "no-match",
      debugInfo
    };
  }, handlePath);
}

// ---------- main API ----------
export async function hasMyCommentAndCache({
  page,
  username,            // login identifier (email/phone/handle). We'll resolve the actual handle.
  postUrl,
  markCommented = false,
}) {
  const shortcode = getShortcodeFromUrl(postUrl);
  console.log(`🔍 ===== COMMENT CHECK START =====`);
  console.log(`🔍 POST: ${postUrl}`);
  console.log(`🔍 SHORTCODE: ${shortcode}`);
  console.log(`🔍 USERNAME: ${username}`);
  console.log(`🔍 MARK_COMMENTED: ${markCommented}`);
  
  if (MEM_CACHE.has(shortcode)) {
    console.log(`✅ CACHE HIT - already commented on ${shortcode}`);
    console.log(`🔍 ===== COMMENT CHECK END: CACHED =====`);
    return true; // fast-path
  }

  // Only navigate if we're not already on the post page
  const currentUrl = page.url();
  if (!currentUrl.includes(shortcode)) {
    console.log(`🔄 NAVIGATING to post: ${postUrl}`);
    await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 10000 });
    // Reduce wait time and make it optional
    try {
      await page.waitForSelector("article, main, [role='main']", { timeout: 3000 });
    } catch {
      console.log('⚠️  Article not found quickly, continuing anyway');
    }
  } else {
    console.log(`✅ ALREADY ON POST: ${currentUrl}`);
  }

  let handle = null;
  
  // PRIORITY 1: Use the username passed from the frontend (from session dropdown)
  if (username && username.trim()) {
    handle = username.trim();
    console.log(`🎯 USING PROVIDED USERNAME: ${handle}`);
  } else {
    // FALLBACK: Try to auto-detect only if no username provided
    console.log(`⚠️  No username provided, attempting auto-detection...`);
    try {
      handle = await getLoggedInHandle(page);
      console.log(`🎯 AUTO-DETECTED HANDLE: ${handle}`);
    } catch (error) {
      console.log(`⚠️  AUTO-DETECTION FAILED: ${error.message}`);
      handle = null;
    }
  }
  
  if (!handle) {
    console.log(`❌ NO HANDLE AVAILABLE - cannot check comments`);
    if (markCommented) { 
      MEM_CACHE.add(shortcode); 
      saveCache(MEM_CACHE);
      console.log(`💾 MARKED AS COMMENTED (no handle): ${shortcode}`);
    }
    console.log(`🔍 ===== COMMENT CHECK END: NO HANDLE =====`);
    return false;
  }

  // Use efficient expansion that stops early when comment is found
  console.log(`🔍 SEARCHING for comments from handle: ${handle}`);
  
  // Try primary method first
  let found = await expandCommentsEfficiently(page, handle);
  console.log(`🔍 PRIMARY SEARCH RESULT: ${found ? 'COMMENT FOUND' : 'NO COMMENT FOUND'}`);
  
  // If primary method fails, try alternative approach
  if (!found) {
    console.log(`🔍 TRYING ALTERNATIVE SEARCH METHOD...`);
    found = await alternativeCommentSearch(page, handle);
    console.log(`🔍 ALTERNATIVE SEARCH RESULT: ${found ? 'COMMENT FOUND' : 'NO COMMENT FOUND'}`);
  }
  
  if (found || markCommented) {
    MEM_CACHE.add(shortcode);
    saveCache(MEM_CACHE);
    console.log(`💾 ADDED TO CACHE: ${shortcode}`);
  }
  
  console.log(`🔍 ===== COMMENT CHECK END: ${found ? 'FOUND' : 'NOT FOUND'} =====`);
  return found;
}
