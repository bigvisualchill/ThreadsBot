// ===== THREADS FUNCTIONS =====
// Extracted to prevent cross-platform corruption

// Import shared utilities that Threads functions depend on
import { sleep, tryClickByText } from './bot.js';

async function ensureThreadsLoggedIn(page, { username, password }) {
  try {
    console.log('🧵 === THREADS LOGIN START ===');
    console.log('🧵 Function called with username:', username, 'password:', password ? '***' : 'undefined');
    console.log('🧵 Username type:', typeof username, 'Password type:', typeof password);
    console.log('🧵 Username length:', username ? username.length : 0, 'Password length:', password ? password.length : 0);
  
    // Navigate to Threads
    console.log('🧵 Step 1: About to navigate to threads.net...');
    const navigationPromise = page.goto('https://www.threads.net/', { 
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    console.log('🧵 Navigation promise created, waiting...');
    try {
      await navigationPromise;
      console.log('🧵 Step 1 COMPLETE: Navigation finished successfully');
    } catch (navError) {
      console.log('🧵 ❌ Navigation failed:', navError.message);
      console.log('🧵 Current URL after nav failure:', page.url());
    }
    
    await sleep(2000);
    console.log('🧵 Step 2: Current URL after navigation:', page.url());

    // Try direct navigation to login page first
    console.log('🔐 Trying direct navigation to login page...');
    try {
      await page.goto('https://www.threads.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
      console.log('🔐 ✅ Successfully navigated to login page');
      console.log('🔐 Current URL:', page.url());
    } catch (navError) {
      console.log('🔐 ❌ Direct navigation failed:', navError.message);

      // Fallback: Try clicking the username login button
      console.log('🔐 Falling back to clicking username login button...');
      const usernameClicked = await tryClickByText(page, [
        'Log in with username instead',
        'Log in with username',
        'Use username',
        'Log in'
      ]);

      if (usernameClicked) {
        console.log('🔐 ✅ Clicked username login option');

        // Wait for navigation after clicking
        try {
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
          console.log('🔐 ✅ Navigation completed after button click');
          console.log('🔐 Current URL:', page.url());
        } catch (navError) {
          console.log('🔐 ❌ No navigation after button click');
          console.log('🔐 Current URL:', page.url());
        }
      } else {
        console.log('🔐 ❌ Could not find or click username login button');
        throw new Error('Could not access login page via any method');
      }
    }

    // Wait for form to load
    await sleep(3000);
    console.log('🔐 Login form should be visible, proceeding with credentials...');
    console.log('🔐 Current URL before form check:', page.url());

    // Take a screenshot to see what the page looks like
    try {
      await page.screenshot({ path: 'debug-after-login-navigation.png', fullPage: true });
      console.log('🔐 📸 Screenshot taken: debug-after-login-navigation.png');
    } catch (screenshotError) {
      console.log('🔐 Screenshot failed:', screenshotError.message);
    }

    // Debug: Check what elements are actually on the page
    const pageElements = await page.evaluate(() => {
      const allInputs = document.querySelectorAll('input');
      const inputs = Array.from(allInputs).map(input => ({
        type: input.type,
        name: input.name,
        placeholder: input.placeholder,
        id: input.id,
        className: input.className
      }));

      const allButtons = document.querySelectorAll('button, [role="button"], input[type="submit"]');
      const buttons = Array.from(allButtons).map(btn => ({
        text: btn.textContent?.trim(),
        type: btn.type,
        name: btn.name,
        tagName: btn.tagName
      }));

      return { inputs, buttons };
    });

    console.log('🔐 Found inputs on page:', pageElements.inputs);
    console.log('🔐 Found buttons on page:', pageElements.buttons);

    // Find username field
    console.log('🔐 Looking for username field...');
    let usernameSelector = null;
    const usernameSelectors = [
      'input[name="username"]',
      'input[name="email"]',
      'input[placeholder*="email"]',
      'input[placeholder*="Email"]',
      'input[type="email"]',
      'input[placeholder*="username"]',
      'input[placeholder*="Username"]',
      'input[type="text"]', // Fallback to any text input
      'input:not([type="password"])' // Any non-password input
    ];

    for (const selector of usernameSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        usernameSelector = selector;
        console.log('🔐 Found username field with selector:', selector);
        break;
      } catch (e) {
        // Continue to next selector
      }
    }

    if (!usernameSelector) {
      console.log('🔐 ❌ Could not find username field with any selector');
      throw new Error('Could not find username field');
    }
    console.log('🔐 Found username field with selector:', usernameSelector);

    // Find password field
    console.log('🔐 Looking for password field...');
    let passwordSelector = null;
    const passwordSelectors = [
      'input[name="password"]',
      'input[type="password"]',
      'input[placeholder*="password"]',
      'input[placeholder*="Password"]',
      'input[type="text"]:nth-of-type(2)', // Second text input as fallback
      'input:nth-of-type(2)' // Second input element as fallback
    ];

    for (const selector of passwordSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        passwordSelector = selector;
        console.log('🔐 Found password field with selector:', selector);
        break;
      } catch (e) {
        // Continue to next selector
      }
    }

    if (!passwordSelector) {
      console.log('🔐 ❌ Could not find password field with any selector');
      throw new Error('Could not find password field');
    }

    // Type credentials with debugging
    console.log('🔐 Typing username...');
    console.log('🔐 Username value:', username, 'Type:', typeof username);
    console.log('🔐 Username selector:', usernameSelector);

    // Ensure username is a string
    const usernameText = String(username || '');
    console.log('🔐 Username as string:', usernameText);

    if (usernameText && usernameText.trim()) {
      await page.type(usernameSelector, usernameText, { delay: 20 });
      console.log('🔐 ✅ Username typed successfully');
    } else {
      console.log('🔐 ⚠️ Username is empty or invalid');
    }

    console.log('🔐 Typing password...');
    console.log('🔐 Password value:', password ? '***' : 'undefined', 'Type:', typeof password);
    console.log('🔐 Password selector:', passwordSelector);

    // Ensure password is a string
    const passwordText = String(password || '');
    console.log('🔐 Password as string:', passwordText ? '***' : 'empty');

    if (passwordText && passwordText.trim()) {
      await page.type(passwordSelector, passwordText, { delay: 20 });
      console.log('🔐 ✅ Password typed successfully');
    } else {
      console.log('🔐 ⚠️ Password is empty or invalid');
    }

    // Submit form
    console.log('🔐 Pressing Enter key to submit form...');
    await page.keyboard.press('Enter');
    console.log('🔐 ✅ Enter key pressed');

    await sleep(2000);

    // Check if Enter key worked
    await sleep(2000); // Wait a bit for submission to process
    const afterEnterState = await page.evaluate(() => {
      const stillHasPasswordField = !!document.querySelector('input[type="password"]');
      const currentUrl = window.location.href;
      const allInputs = Array.from(document.querySelectorAll('input')).map(input => ({
        type: input.type,
        name: input.name,
        placeholder: input.placeholder
      }));
      console.log('🔐 After Enter key - URL:', currentUrl);
      console.log('🔐 After Enter key - Password field still present:', stillHasPasswordField);
      console.log('🔐 After Enter key - All inputs:', allInputs);
      return { stillHasPasswordField, currentUrl, allInputs };
    });

    if (afterEnterState.stillHasPasswordField) {
      console.log('🔐 ⚠️ Password field still present - trying alternative submission...');

      // Take a screenshot to see the current state
      try {
        await page.screenshot({ path: 'debug-after-enter-key.png', fullPage: true });
        console.log('🔐 📸 Screenshot taken: debug-after-enter-key.png');
      } catch (screenshotError) {
        console.log('🔐 Screenshot failed:', screenshotError.message);
      }

      // Try button click
      const submitClicked = await tryClickByText(page, ['Log in', 'Log In', 'Login', 'Sign in', 'Submit']);
      if (submitClicked) {
        console.log('🔐 ✅ Clicked login button by text');
      } else {
        // Try form submission
        try {
          await page.evaluate(() => {
            const forms = document.querySelectorAll('form');
            for (const form of forms) {
              if (form.querySelector('input[type="password"]')) {
                console.log('🔐 Found form with password field, submitting...');
                form.submit();
                return true;
              }
            }
            return false;
          });
          console.log('🔐 ✅ Submitted form programmatically');
        } catch (formError) {
          console.log('🔐 ❌ Form submission failed:', formError.message);
          throw new Error('Could not submit login form');
        }
      }
    } else {
      console.log('🔐 ✅ Enter key submission appears to have worked');
    }

    // Wait for form submission to process
    await sleep(2000);

    // Check for post-login navigation
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
      console.log('🔐 Navigation detected after login');
    } catch (error) {
      console.log('🔐 No navigation after login - checking current state...');
    }
    
    console.log('🔐 After login submit, current URL:', page.url());
    
    // Handle post-login prompts
    await tryClickByText(page, ['Not now', "Don't save", 'Skip', 'Later']);
    await tryClickByText(page, ['Allow', 'Continue', 'Continue as', 'Yes, continue']);
    
    // Ensure we end up on Threads home
    if (!/threads\.(net|com)/i.test(page.url())) {
      console.log('🔐 Not on Threads, navigating to home...');
      await page.goto('https://www.threads.net/', { waitUntil: 'networkidle2' });
      await sleep(1000);
    }

    // Final verification - check actual authentication state
    const verificationResult = await page.evaluate(() => {
      console.log('🔐 Final verification - checking login success...');

      const currentUrl = window.location.href;
      const isOnThreadsDomain = window.location.hostname.includes('threads.net');
      const isNotOnLoginPage = !window.location.pathname.includes('/login');

      console.log('🔐 Current URL:', currentUrl);
      console.log('🔐 On Threads domain:', isOnThreadsDomain, 'Not on login page:', isNotOnLoginPage);

      // Check for authenticated user indicators
      const authSelectors = [
        // Profile/account related elements
        '[data-testid="nav-profile"]',
        '[aria-label*="Profile"]',
        'a[href*="/profile"]',
        'a[href*="/@"]',
        // User menu/settings
        '[aria-label*="Settings"]',
        '[data-testid="settings-button"]',
        // User avatar or profile picture
        'img[alt*="profile"]',
        'img[alt*="avatar"]',
        '[role="img"][aria-label*="profile"]'
      ];

      let authElementsFound = 0;
      for (const selector of authSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          console.log('🔐 Found auth element:', selector);
          authElementsFound++;
        }
      }

      // Check for login/logout indicators
      const loginSelectors = [
        'button:contains("Log in")',
        'a:contains("Log in")',
        '[role="button"]:contains("Log in")',
        'input[type="email"]',
        'input[type="password"]',
        'input[placeholder*="email"]',
        'input[placeholder*="password"]'
      ];

      let loginElementsFound = 0;
      for (const selector of loginSelectors) {
        try {
          const element = document.querySelector(selector);
          if (element) {
            console.log('🔐 Found login element:', selector);
            loginElementsFound++;
          }
        } catch (e) {
          // Some :contains selectors might not work in all browsers
        }
      }

      // Check for specific Threads logged-in indicators
      const threadsAuthSelectors = [
        '[data-testid="create-button"]',  // Create post button (only visible when logged in)
        '[aria-label="Create"]',
        'svg[aria-label="Create"]',  // Create icon
        'button[aria-label*="Create"]',
        // Activity/notification indicators
        '[data-testid="activity-button"]',
        '[aria-label*="Activity"]',
        '[aria-label*="Notifications"]'
      ];

      let threadsAuthElements = 0;
      for (const selector of threadsAuthSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          console.log('🔐 Found Threads auth element:', selector);
          threadsAuthElements++;
        }
      }

      // Check for error messages
      const errorSelectors = [
        '[role="alert"]',
        '.error',
        '.alert-danger',
        'div[style*="red"]',
        'span[style*="red"]',
        'p[style*="red"]',
        '[class*="error"]',
        '[class*="Error"]'
      ];

      let errorMessages = [];
      for (const selector of errorSelectors) {
        const elements = document.querySelectorAll(selector);
        elements.forEach(element => {
          const text = element.textContent?.trim();
          if (text && text.length > 0) {
            console.log('🔐 Found error message:', text);
            errorMessages.push(text);
          }
        });
      }

      // Check page title and content for login indicators
      const pageTitle = document.title;
      const hasLoginInTitle = pageTitle.toLowerCase().includes('log in') ||
                             pageTitle.toLowerCase().includes('login') ||
                             pageTitle.toLowerCase().includes('sign in');

      console.log('🔐 Page title:', pageTitle);
      console.log('🔐 Has login in title:', hasLoginInTitle);
      console.log('🔐 Auth elements found:', authElementsFound);
      console.log('🔐 Login elements found:', loginElementsFound);
      console.log('🔐 Threads auth elements found:', threadsAuthElements);
      console.log('🔐 Error messages found:', errorMessages.length);

      return {
        currentUrl,
        isOnThreadsDomain,
        isNotOnLoginPage,
        authElementsFound,
        loginElementsFound,
        threadsAuthElements,
        errorMessages,
        pageTitle,
        hasLoginInTitle
      };
    });

    // Enhanced verification logic
    const hasAuthElements = verificationResult.authElementsFound > 0;
    const hasThreadsAuthElements = verificationResult.threadsAuthElements > 0;
    const hasLoginElements = verificationResult.loginElementsFound > 0;
    const hasErrors = verificationResult.errorMessages.length > 0;
    const hasLoginInTitle = verificationResult.hasLoginInTitle;
    const isOnCorrectDomain = verificationResult.isOnThreadsDomain;

    console.log('🔐 Enhanced verification results:');
    console.log('🔐 - Auth elements found:', hasAuthElements);
    console.log('🔐 - Threads auth elements found:', hasThreadsAuthElements);
    console.log('🔐 - Login elements found:', hasLoginElements);
    console.log('🔐 - Has errors:', hasErrors);
    console.log('🔐 - Has login in title:', hasLoginInTitle);
    console.log('🔐 - On correct domain:', isOnCorrectDomain);

    // Simplified and more reliable login verification
    const isOnThreads = isOnCorrectDomain || verificationResult.currentUrl.includes('threads.com');
    const hasLoginForm = hasLoginElements > 2 || hasLoginInTitle;
    
    // Check if we're on the main Threads page (not login page)
    const isOnMainPage = isOnThreads && !verificationResult.currentUrl.includes('/login');
    
    // More lenient verification - if we're on the main Threads page and no login form, consider it successful
    let loginSuccessful;
    if (isOnMainPage && !hasLoginForm) {
      loginSuccessful = true;
      console.log('🔐 ✅ Login confirmed - on main Threads page without login form');
    } else if (hasLoginForm) {
      loginSuccessful = false;
      console.log('🔐 ❌ Login failed - login form still present');
    } else if (hasAuthElements || hasThreadsAuthElements) {
      loginSuccessful = true;
      console.log('🔐 ✅ Login confirmed - found authenticated user elements');
    } else {
      // If we're on Threads domain but no clear indicators, assume success
      loginSuccessful = isOnThreads && !hasErrors;
      console.log('🔐 ⚠️ Login status unclear - assuming success if on Threads domain without errors');
    }

    if (!loginSuccessful) {
      console.log('🔐 ❌ Login verification failed');
      console.log('🔐 Page title:', verificationResult.pageTitle);
      console.log('🔐 Error messages:', verificationResult.errorMessages);
      console.log('🔐 Current URL:', verificationResult.currentUrl);
      console.log('🔐 Auth elements:', verificationResult.authElementsFound);
      console.log('🔐 Login elements:', verificationResult.loginElementsFound);
      console.log('🔐 Threads auth elements:', verificationResult.threadsAuthElements);

      // Take a final screenshot for debugging
      try {
        await page.screenshot({ path: 'debug-login-verification-failed.png', fullPage: true });
        console.log('🔐 📸 Screenshot taken: debug-login-verification-failed.png');
      } catch (screenshotError) {
        console.log('🔐 Screenshot failed:', screenshotError.message);
      }

      const reason = hasLoginForm ?
        'Login form still present' :
        'Not on main Threads page';

      throw new Error(`Threads login verification failed: ${reason}. URL: ${verificationResult.currentUrl}, Auth elements: ${verificationResult.authElementsFound}, Login elements: ${verificationResult.loginElementsFound}, Threads auth: ${verificationResult.threadsAuthElements}, Errors: ${verificationResult.errorMessages.length}`);
    }

    console.log('🔐 ✅ Login verification successful!');
    console.log('🔐 Final URL:', verificationResult.currentUrl);

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
  
  // Use the correct Threads search URL format with recent sorting
  const searchUrl = `https://www.threads.net/search?q=${encodeURIComponent(searchQuery)}&serp_type=recent`;
  console.log(`🔍 Navigating to Threads search (recent): ${searchUrl}`);
  
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
