// instagram-functions.js
import { sleep, tryClickByText } from './bot.js';
import { hasMyCommentAndCache } from './utils/igHasMyComment.js';

// Global sets to track liked posts
const likedPosts = new Set();
const discoveredPosts = new Set();

// Post Discovery Functions
export async function discoverInstagramPosts(page, searchCriteria, maxPosts = 10) {
  console.log(`🚀 DISCOVERY: Starting Instagram post discovery with criteria:`, searchCriteria);
  console.log(`🚀 DISCOVERY: Max posts requested: ${maxPosts}`);
  console.log(`🚀 DISCOVERY: Currently discovered posts: ${discoveredPosts.size}`);
  
  const { hashtag, keywords } = searchCriteria;
  
  let searchUrl;
  if (hashtag) {
    searchUrl = `https://www.instagram.com/explore/tags/${hashtag.replace('#', '')}/`;
  } else if (keywords) {
    searchUrl = `https://www.instagram.com/explore/tags/${keywords.replace('#', '')}/`;
  } else {
    throw new Error('Either hashtag or keywords must be provided');
  }

  console.log(`🚀 DISCOVERY: Navigating to search URL: ${searchUrl}`);
  await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);

  // Click on "Recent" tab to get latest posts instead of popular
  console.log(`🚀 DISCOVERY: Switching to Recent posts for latest content`);
  try {
    await page.waitForSelector('div[role="tablist"] a, div[role="tablist"] button', { timeout: 5000 });
    
    const recentTabClicked = await page.evaluate(() => {
      // Look for Recent tab - could be text or could be an icon
      const tabs = Array.from(document.querySelectorAll('div[role="tablist"] a, div[role="tablist"] button'));
      
      for (const tab of tabs) {
        const text = tab.textContent?.toLowerCase() || '';
        // Look for "Recent" text or check if it's the second tab (Recent is usually after Top)
        if (text.includes('recent') || text.includes('latest') || tabs.indexOf(tab) === 1) {
          console.log('Found Recent tab, clicking...');
          tab.click();
          return true;
        }
      }
      
      // If no text match, try clicking the second tab (Recent is typically 2nd)
      if (tabs.length >= 2) {
        console.log('No Recent text found, clicking second tab (likely Recent)');
        tabs[1].click();
        return true;
      }
      
      return false;
    });
    
    if (recentTabClicked) {
      console.log(`✅ DISCOVERY: Switched to Recent tab`);
      await sleep(3000); // Wait for recent posts to load
    } else {
      console.log(`⚠️ DISCOVERY: Could not find Recent tab, using default view`);
    }
  } catch (recentError) {
    console.log(`⚠️ DISCOVERY: Could not switch to Recent tab: ${recentError.message}`);
  }

  // Check for login wall
  const needsLogin = await page.evaluate(() => {
    return document.querySelector('[role="dialog"]') || 
           document.querySelector('input[name="username"]') ||
           document.body.textContent.includes('Log in to see photos');
  });

  if (needsLogin) {
    console.log('⚠️ Instagram login wall detected during discovery');
    throw new Error('Instagram login required for post discovery');
  }

  const posts = [];
  let attempts = 0;
  const maxAttempts = 50;

  while (posts.length < maxPosts && attempts < maxAttempts) {
    attempts++;
    console.log(`🚀 DISCOVERY: Attempt ${attempts}/${maxAttempts}, found ${posts.length}/${maxPosts} posts`);

    // Get post links
    const newPosts = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/p/"]'));
      return links
        .map(link => link.href)
        .filter(href => href.includes('/p/'))
        .slice(0, 50); // Limit to avoid overwhelming
    });

    console.log(`🚀 DISCOVERY: Found ${newPosts.length} post links on page`);

    // Add new unique posts
    for (const postUrl of newPosts) {
      if (!discoveredPosts.has(postUrl) && posts.length < maxPosts) {
        discoveredPosts.add(postUrl);
        posts.push(postUrl);
        console.log(`🚀 DISCOVERY: Added post ${posts.length}/${maxPosts}: ${postUrl}`);
      }
    }

    if (posts.length >= maxPosts) {
      console.log(`🚀 DISCOVERY: Reached target of ${maxPosts} posts`);
      break;
    }

    // Scroll to load more posts
    console.log(`🚀 DISCOVERY: Scrolling to load more posts...`);
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await sleep(3000);

    // Check if we're at the bottom or no new content is loading
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    await sleep(2000);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    
    if (currentHeight === newHeight && attempts > 5) {
      console.log(`🚀 DISCOVERY: No new content loading, stopping discovery`);
      break;
    }
  }

  console.log(`🚀 DISCOVERY: Discovery complete - found ${posts.length} posts in ${attempts} attempts`);
  return posts;
}

// Instagram flows
export async function ensureInstagramLoggedIn(page, { username, password }) {
  try {
    console.log('Checking Instagram login status...');
    
    // First, go to Instagram home to check current status
    const currentUrl = page.url();
    if (!currentUrl.includes('instagram.com')) {
      await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2' });
      await sleep(2000);
    }

    // Check if already logged in with comprehensive detection
    const initialLoginCheck = await page.evaluate(() => {
      const debugLog = [];
      const currentUrl = window.location.href;
      debugLog.push(`Checking login status on URL: ${currentUrl}`);
      
      // First check: Are we on a login page?
      if (currentUrl.includes('/accounts/login/')) {
        debugLog.push('On login page - NOT logged in');
        return { isLoggedIn: false, debugLog };
      }
      
      // Second check: Look for login indicators
      const loginIndicators = [
        'svg[aria-label="Home"]',
        'svg[aria-label="Search"]', 
        'svg[aria-label="New post"]',
        'svg[aria-label="Activity Feed"]',
        'svg[aria-label="Profile"]',
        '[data-testid="user-avatar"]',
        'a[aria-label*="Profile"]',
        'a[href*="/accounts/edit/"]',
        'nav[role="navigation"]',
        '[role="main"]'
      ];
      
      const foundIndicators = [];
      for (const selector of loginIndicators) {
        const element = document.querySelector(selector);
        if (element) {
          foundIndicators.push(selector);
        }
      }
      debugLog.push(`Found login indicators: ${foundIndicators.join(', ')}`);
      
      // Third check: Look for login form elements (indicates NOT logged in)
      const loginFormElements = [
        'input[name="username"]',
        'input[name="password"]',
        'input[placeholder*="Phone number, username, or email"]'
      ];
      
      const foundLoginElements = [];
      for (const selector of loginFormElements) {
        const element = document.querySelector(selector);
        if (element) {
          foundLoginElements.push(selector);
        }
      }
      debugLog.push(`Found login form elements: ${foundLoginElements.join(', ')}`);
      
      // Fourth check: Check page title
      const pageTitle = document.title;
      debugLog.push(`Page title: ${pageTitle}`);
      
      const titleIndicatesLogin = pageTitle.includes('Login') || pageTitle.includes('Sign up');
      if (titleIndicatesLogin) {
        debugLog.push('Page title indicates login page - NOT logged in');
      }
      
      // Determine login status
      const hasLoginIndicators = foundIndicators.length > 0;
      const hasLoginForm = foundLoginElements.length > 0;
      const onLoginPage = currentUrl.includes('/accounts/login/');
      
      // We're logged in if we have indicators AND no login form AND not on login page
      const isLoggedIn = hasLoginIndicators && !hasLoginForm && !onLoginPage && !titleIndicatesLogin;
      
      debugLog.push(`Login status determination:`);
      debugLog.push(`  - Has login indicators: ${hasLoginIndicators} (${foundIndicators.length})`);
      debugLog.push(`  - Has login form: ${hasLoginForm}`);
      debugLog.push(`  - On login page: ${onLoginPage}`);
      debugLog.push(`  - Title indicates login: ${titleIndicatesLogin}`);
      debugLog.push(`  - Final result: ${isLoggedIn}`);
      
      return { isLoggedIn, debugLog, foundIndicators, foundLoginElements };
    });

    // Log debug information
    console.log('=== Instagram Login Status Check ===');
    initialLoginCheck.debugLog.forEach(log => console.log(log));
    console.log('====================================');

    if (initialLoginCheck.isLoggedIn) {
      console.log('✅ Already logged into Instagram');
      return true;
    }

    console.log('🔐 Not logged in, proceeding with login...');

    // Validate credentials before attempting login
    if (!username || !password) {
      throw new Error('Instagram session missing and no credentials provided. Provide username/password or login headfully and save a session.');
    }

    // Navigate to login page if not already there
    const needsNavigation = await page.evaluate(() => {
      return !document.querySelector('input[name="username"]');
    });

    if (needsNavigation) {
      console.log('📍 Navigating to Instagram login page...');
      await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle2' });
      await sleep(2000);
    }

    // Wait for login form
    await page.waitForSelector('input[name="username"]', { timeout: 10000 });
    console.log('📝 Login form found');

    // Clear and fill username
    await page.click('input[name="username"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.type('input[name="username"]', username);
    await sleep(500);

    // Clear and fill password
    await page.click('input[name="password"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.type('input[name="password"]', password);
    await sleep(500);

    // Submit login
    console.log('🚀 Submitting login...');
    await page.click('button[type="submit"]');
    
    // Wait for navigation or error
    await sleep(3000);

    // Check for login success with comprehensive debugging
    const loginCheckResult = await page.evaluate(() => {
      const debugLog = [];
      const currentUrl = window.location.href;
      debugLog.push(`Current URL after login: ${currentUrl}`);
      
      // Look for successful login indicators
      const indicators = [
        'svg[aria-label="Home"]',
        '[data-testid="user-avatar"]', 
        'a[aria-label*="Profile"]',
        'svg[aria-label="Search"]',
        'svg[aria-label="New post"]',
        'a[href*="/accounts/edit/"]',
        'nav[role="navigation"]',
        '[role="main"]'
      ];
      
      const foundIndicators = [];
      for (const selector of indicators) {
        const element = document.querySelector(selector);
        if (element) {
          foundIndicators.push(selector);
        }
      }
      debugLog.push(`Found login indicators: ${foundIndicators.join(', ')}`);
      
      // Check for error messages
      const errorSelectors = [
        '#slfErrorAlert',
        '[role="alert"]',
        '[data-testid="loginForm"] div[role="alert"]'
      ];
      
      const foundErrors = [];
      let hasTextError = false;
      
      for (const selector of errorSelectors) {
        const element = document.querySelector(selector);
        if (element && element.textContent.trim()) {
          foundErrors.push(`${selector}: ${element.textContent.trim()}`);
        }
      }
      
      // Check for text-based error messages
      if (document.body.textContent.includes('Sorry, your password was incorrect') ||
          document.body.textContent.includes('The username you entered')) {
        hasTextError = true;
        foundErrors.push('Text-based error message found');
      }
      
      debugLog.push(`Found error messages: ${foundErrors.length > 0 ? foundErrors.join(', ') : 'None'}`);
      
      // Check if we're still on login page
      const stillOnLoginPage = currentUrl.includes('/accounts/login/') || 
                              document.querySelector('input[name="username"]') ||
                              document.querySelector('input[name="password"]');
      
      debugLog.push(`Still on login page: ${stillOnLoginPage}`);
      
      // Determine success - we're successful if:
      // 1. We have login indicators AND no errors, OR
      // 2. We're not on login page and no errors
      const hasErrors = foundErrors.length > 0 || hasTextError;
      const hasIndicators = foundIndicators.length > 0;
      const notOnLoginPage = !stillOnLoginPage;
      
      const isSuccessful = (hasIndicators || notOnLoginPage) && !hasErrors;
      
      debugLog.push(`Login success determination:`);
      debugLog.push(`  - Has indicators: ${hasIndicators}`);
      debugLog.push(`  - Not on login page: ${notOnLoginPage}`);
      debugLog.push(`  - Has errors: ${hasErrors}`);
      debugLog.push(`  - Final result: ${isSuccessful}`);
      
      return {
        success: isSuccessful,
        debugLog,
        foundIndicators,
        foundErrors,
        currentUrl
      };
    });

    // Log all debug information
    console.log('=== Instagram Login Success Detection ===');
    loginCheckResult.debugLog.forEach(log => console.log(log));
    console.log('==========================================');

    if (!loginCheckResult.success) {
      // Get more specific error information
      const errorText = loginCheckResult.foundErrors.length > 0 
        ? loginCheckResult.foundErrors[0] 
        : 'Login detection failed - no success indicators found';
      
      throw new Error(`Instagram login failed: ${errorText}`);
    }

    console.log('✅ Instagram login detected as successful');

    // Handle potential "Save Login Info" dialog
    try {
      await sleep(2000);
      const saveInfoDialog = await page.$('button:has-text("Not Now")') || 
                            await page.$('button:has-text("Save Info")');
      if (saveInfoDialog) {
        console.log('📱 Dismissing "Save Login Info" dialog...');
        await page.click('button:has-text("Not Now")');
        await sleep(1000);
      }
    } catch (e) {
      // Dialog might not appear, that's fine
    }

    // Handle potential notification dialog
    try {
      await sleep(2000);
      const notificationDialog = await page.$('button:has-text("Not Now")') ||
                                await page.$('button:has-text("Turn On")');
      if (notificationDialog) {
        console.log('🔔 Dismissing notification dialog...');
        await page.click('button:has-text("Not Now")');
        await sleep(1000);
      }
    } catch (e) {
      // Dialog might not appear, that's fine
    }

    console.log('✅ Instagram login successful');
    return true;

  } catch (error) {
    console.error('❌ Instagram login error:', error);
    throw error;
  }
}

export async function instagramLike(page, postUrl) {
  console.log(`🚀 NEW CODE: instagramLike function called with URL: ${postUrl}`);
  
  // Check if this post has already been liked
  if (likedPosts.has(postUrl)) {
    console.log(`🚀 SKIPPING: Post ${postUrl} has already been liked`);
    return true; // Return true to indicate "success" (already liked)
  }

  try {
    console.log(`🚀 NEW CODE: Navigating to post: ${postUrl}`);
    await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);

    // Check if already liked
    console.log(`🚀 NEW CODE: Checking if post is already liked...`);
    const alreadyLiked = await page.evaluate(() => {
      // Look for filled heart (liked state)
      const likedHeart = document.querySelector('svg[aria-label="Unlike"]') ||
                        document.querySelector('svg[fill="#ed4956"]') || // Instagram red color
                        document.querySelector('button[aria-label="Unlike"]');
      return !!likedHeart;
    });

    if (alreadyLiked) {
      console.log(`🚀 NEW CODE: Post is already liked, marking as complete`);
      likedPosts.add(postUrl);
      return true;
    }

    // Find and click like button
    console.log(`🚀 NEW CODE: Looking for like button...`);
    const likeButton = await page.$('svg[aria-label="Like"]') ||
                      await page.$('button[aria-label="Like"]') ||
                      await page.$('span[aria-label="Like"]');

    if (!likeButton) {
      console.log(`🚀 NEW CODE: Like button not found, trying alternative selectors...`);
      
      // Try clicking on heart icon directly
      const heartIcon = await page.$('svg') ||
                       await page.$('[role="button"]');
      
      if (heartIcon) {
        console.log(`🚀 NEW CODE: Trying to click heart icon...`);
        await heartIcon.click();
        await sleep(1000);
      } else {
        throw new Error('Like button not found');
      }
    } else {
      console.log(`🚀 NEW CODE: Clicking like button...`);
      await likeButton.click();
      await sleep(1000);
    }

    // Verify the like was successful
    console.log(`🚀 NEW CODE: Verifying like was successful...`);
    const likeSuccessful = await page.evaluate(() => {
      const likedHeart = document.querySelector('svg[aria-label="Unlike"]') ||
                        document.querySelector('svg[fill="#ed4956"]') ||
                        document.querySelector('button[aria-label="Unlike"]');
      return !!likedHeart;
    });

    if (likeSuccessful) {
      console.log(`🚀 NEW CODE: Successfully liked post: ${postUrl}`);
      likedPosts.add(postUrl);
      return true;
    } else {
      throw new Error('Like action did not complete successfully');
    }

  } catch (error) {
    console.error(`🚀 NEW CODE: Error liking post ${postUrl}:`, error.message);
    throw error;
  }
}

export async function instagramComment(page, postUrl, comment, username) {
  console.log(`💬 ===== INSTAGRAM COMMENT START =====`);
  console.log(`💬 POST: ${postUrl}`);
  console.log(`💬 COMMENT: ${comment}`);
  console.log(`💬 USERNAME: ${username}`);
  
  try {
    // Check if we already have a comment on this post
    console.log(`🔍 Checking if we already commented on this post...`);
    const alreadyCommented = await hasMyCommentAndCache({
      page,
      username,
      postUrl,
      markCommented: false
    });

    if (alreadyCommented) {
      console.log(`⏭️ SKIP: Already commented on this post`);
      return { 
        success: false, 
        skipped: true, 
        reason: 'Already commented on this post',
        postUrl 
      };
    }

    console.log(`🌐 Navigating to post: ${postUrl}`);
    await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);

    // Check for login wall
    const loginWall = await page.evaluate(() => {
      return document.querySelector('[role="dialog"]') || 
             document.querySelector('input[name="username"]') ||
             document.body.textContent.includes('Log in to see photos');
    });
    if (loginWall) {
      console.log('⚠️ Instagram login wall detected — ensure ensureInstagramLoggedIn() succeeded.');
    }

    // Look for comment input field
    console.log(`💬 Looking for comment input field...`);
    
    // Wait for comment section to load
    await sleep(2000);
    
    // Try multiple selectors for comment input
    let commentInput = null;
    const commentSelectors = [
      'textarea[placeholder*="comment" i]',
      'textarea[aria-label*="comment" i]',
      'textarea[placeholder*="Add a comment"]',
      'textarea[aria-label*="Add a comment"]',
      'textarea',
      'input[placeholder*="comment" i]',
      'input[aria-label*="comment" i]'
    ];

    for (const selector of commentSelectors) {
      try {
        commentInput = await page.$(selector);
        if (commentInput) {
          console.log(`💬 Found comment input with selector: ${selector}`);
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    if (!commentInput) {
      console.log(`💬 Comment input not found, trying to scroll to load comments section...`);
      await page.evaluate(() => {
        window.scrollBy(0, 500);
      });
      await sleep(2000);

      // Try again after scrolling
      for (const selector of commentSelectors) {
        try {
          commentInput = await page.$(selector);
          if (commentInput) {
            console.log(`💬 Found comment input after scrolling with selector: ${selector}`);
            break;
          }
        } catch (e) {
          // Continue to next selector
        }
      }
    }

    if (!commentInput) {
      throw new Error('Comment input field not found');
    }

    // Click on the comment input to focus it
    console.log(`💬 Clicking on comment input to focus...`);
    await commentInput.click();
    await sleep(1000);

    // Type the comment
    console.log(`💬 Typing comment: "${comment}"`);
    await commentInput.type(comment);
    await sleep(1000);

    // Submit the comment
    console.log(`💬 Submitting comment...`);
    
    // Try to find and click submit button
    let submitted = false;
    
    // Method 1: Look for Post/Submit button
    const submitSelectors = [
      'button:has-text("Post")',
      'button[type="submit"]',
      'button:has-text("Share")',
      '[role="button"]:has-text("Post")'
    ];

    for (const selector of submitSelectors) {
      try {
        const submitBtn = await page.$(selector);
        if (submitBtn) {
          console.log(`💬 Found submit button with selector: ${selector}`);
          await submitBtn.click();
          submitted = true;
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    // Method 2: Try Enter key if button not found
    if (!submitted) {
      console.log(`💬 Submit button not found, trying Enter key...`);
      await page.keyboard.press('Enter');
      submitted = true;
    }

    await sleep(3000);

    // Verify comment was posted by checking if input is cleared or comment appears
    console.log(`💬 Verifying comment was posted...`);
    const commentPosted = await page.evaluate((commentText) => {
      // Check if comment input is cleared
      const input = document.querySelector('textarea[placeholder*="comment" i]') ||
                   document.querySelector('textarea[aria-label*="comment" i]') ||
                   document.querySelector('textarea');
      
      const inputCleared = input && input.value.trim() === '';
      
      // Also check if our comment appears in the comments section
      const commentAppeared = document.body.textContent.includes(commentText);
      
      return inputCleared || commentAppeared;
    }, comment);

    if (commentPosted) {
      console.log(`✅ Comment posted successfully: ${postUrl}`);
      
      // Mark this post as commented in our cache
      await hasMyCommentAndCache({
        page,
        username,
        postUrl,
        markCommented: true
      });
      
      console.log(`💬 ===== INSTAGRAM COMMENT END: SUCCESS =====`);
      return { success: true, postUrl };
    } else {
      throw new Error('Comment verification failed - comment may not have been posted');
    }

  } catch (error) {
    console.error(`❌ Error commenting on Instagram post ${postUrl}:`, error.message);
    console.log(`💬 ===== INSTAGRAM COMMENT END: ERROR =====`);
    throw error;
  }
}
