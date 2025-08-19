// ===== THREADS FUNCTIONS =====
// Extracted to prevent cross-platform corruption

// Import shared utilities that Threads functions depend on
import { sleep, tryClickByText } from './bot.js';

async function ensureThreadsLoggedIn(page, { username, password }) {
  console.log('🧵 === THREADS LOGIN START ===');
  console.log('🧵 Function called with username:', !!username, 'password:', !!password);
  
  try {
    console.log('🧵 Step 1: About to navigate to threads.net...');
    
    // Add timeout to navigation to prevent hanging
    const navigationPromise = page.goto('https://www.threads.net/', { 
      waitUntil: 'networkidle2',
      timeout: 30000 // 30 second timeout
    });
    
    console.log('🧵 Navigation promise created, waiting...');
    try {
      await navigationPromise;
      console.log('🧵 Step 1 COMPLETE: Navigation finished successfully');
    } catch (navError) {
      console.log('🧵 ❌ Navigation failed:', navError.message);
      console.log('🧵 Current URL after nav failure:', page.url());
      // Continue anyway to see what we can do
    }
    
    await sleep(2000);
    console.log('🧵 Step 2: Current URL after navigation:', page.url());

    // 2) If already logged in, bail early
    console.log('🧵 Step 3: About to check login status...');
    const already = await page.evaluate(() => {
      console.log('🧵 Step 3a: Inside page.evaluate - checking login status...');
      console.log('🧵 Current URL:', window.location.href);
      console.log('🧵 Page title:', document.title);
      console.log('🧵 Document ready state:', document.readyState);
      
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
      console.log('❌ Missing credentials:');
      console.log('   Username provided:', !!username);
      console.log('   Password provided:', !!password);
      throw new Error('Threads session missing and no credentials provided. Provide username/password or login headfully and save a session.');
    }
    
    console.log('✅ Credentials available, proceeding with Instagram SSO login...');

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
  
  // Look for like button using multiple strategies
  const likeSelectors = [
    '[aria-label="Like"]',
    '[data-testid="like-button"]',
    'button[aria-label*="like"]',
    '[role="button"][aria-label*="Like"]'
  ];
  
  let liked = false;
  for (const selector of likeSelectors) {
    try {
      const likeButton = await page.$(selector);
      if (likeButton) {
        await likeButton.click();
        console.log(`✅ Threads post liked using selector: ${selector}`);
        liked = true;
        break;
      }
    } catch (error) {
      console.log(`Failed to click like with selector ${selector}: ${error.message}`);
    }
  }
  
  if (!liked) {
    // Try text-based approach as fallback
    const textLiked = await tryClickByText(page, ['Like', 'Heart']);
    if (textLiked) {
      console.log('✅ Threads post liked using text-based approach');
      liked = true;
    }
  }
  
  if (!liked) {
    throw new Error('Could not find or click like button on Threads post');
  }
  
  await sleep(1000); // Wait for like action to complete
  return { success: true };
}

async function threadsComment(page, threadUrl, comment) {
  console.log(`💬 Attempting to comment on Threads post: ${threadUrl}`);
  console.log(`Comment text: "${comment}"`);
  
  await page.goto(threadUrl, { waitUntil: 'networkidle2' });
  await sleep(1000);
  
  // Look for reply/comment button
  const replySelectors = [
    '[aria-label="Reply"]',
    '[data-testid="reply-button"]',
    'button[aria-label*="reply"]',
    '[role="button"][aria-label*="Reply"]'
  ];
  
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
      console.log(`Failed to click reply with selector ${selector}: ${error.message}`);
    }
  }
  
  if (!replyClicked) {
    // Try text-based approach
    const textReplyClicked = await tryClickByText(page, ['Reply', 'Comment']);
    if (textReplyClicked) {
      console.log('✅ Reply button clicked using text-based approach');
      replyClicked = true;
    }
  }
  
  if (!replyClicked) {
    throw new Error('Could not find or click reply button on Threads post');
  }
  
  await sleep(2000); // Wait for comment box to appear
  
  // Look for comment text area
  const textareaSelectors = [
    'textarea[placeholder*="reply"]',
    'textarea[placeholder*="comment"]',
    'textarea[aria-label*="reply"]',
    'textarea[data-testid*="comment"]',
    'div[contenteditable="true"]',
    'textarea'
  ];
  
  let commented = false;
  for (const selector of textareaSelectors) {
    try {
      const textarea = await page.$(selector);
      if (textarea) {
        await textarea.click();
        await textarea.type(comment, { delay: 50 });
        console.log(`✅ Comment typed using selector: ${selector}`);
        
        // Look for submit button
        const submitSelectors = [
          'button[type="submit"]',
          '[data-testid="post-button"]',
          'button[aria-label*="post"]',
          'button[aria-label*="reply"]'
        ];
        
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
            console.log(`Failed to submit with selector ${submitSelector}: ${error.message}`);
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
      console.log(`Failed to use textarea selector ${selector}: ${error.message}`);
    }
  }
  
  if (!commented) {
    throw new Error('Could not find comment textarea on Threads post');
  }
  
  await sleep(2000); // Wait for comment to post
  console.log('✅ Threads comment posted successfully');
  return { success: true };
}

async function discoverThreadsPosts(page, searchCriteria, maxPosts = 10) {
  console.log(`🧵 Starting Threads post discovery for: ${JSON.stringify(searchCriteria)}`);
  
  const { hashtag, keywords } = searchCriteria;
  let searchQuery = hashtag || keywords;
  
  if (!searchQuery) {
    throw new Error('Either hashtag or keywords must be provided for Threads search');
  }
  
  // Use the correct Threads search URL format
  const searchUrl = `https://www.threads.net/search?q=${encodeURIComponent(searchQuery)}&serp_type=default`;
  console.log(`🔍 Navigating to Threads search: ${searchUrl}`);
  
  await page.goto(searchUrl, { waitUntil: 'networkidle2' });
  await sleep(3000); // Wait for search results to load
  
  // Extract post URLs from search results
  const postUrls = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="/post/"]');
    const urls = [];
    
    links.forEach(link => {
      const href = link.getAttribute('href');
      if (href && href.includes('/post/')) {
        const fullUrl = href.startsWith('http') ? href : `https://www.threads.net${href}`;
        urls.push(fullUrl);
      }
    });
    
    return [...new Set(urls)]; // Remove duplicates
  });
  
  console.log(`🧵 Found ${postUrls.length} potential Threads posts`);
  
  // Limit to requested number of posts
  const limitedPosts = postUrls.slice(0, maxPosts);
  console.log(`🧵 Returning ${limitedPosts.length} posts (limited to ${maxPosts})`);
  
  return limitedPosts;
}

// Export all functions
export {
  ensureThreadsLoggedIn,
  threadsLike,
  threadsComment,
  discoverThreadsPosts
};
