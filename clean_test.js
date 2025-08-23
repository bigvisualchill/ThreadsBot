async function test() {
  try {
    const verificationResult = await page.evaluate(() => {
      return {
        navElementsFound: 0,
        errorMessages: [],
        loginFormPresent: true,
        isOnThreadsDomain: false,
        isNotOnLoginPage: false,
        currentUrl: 'test'
      };
    });

    const hasNavElements = verificationResult.navElementsFound > 0;
    const noErrors = verificationResult.errorMessages.length === 0;
    const noLoginForm = !verificationResult.loginFormPresent;
    const isOnCorrectDomain = verificationResult.isOnThreadsDomain;
    const notOnLoginPage = verificationResult.isNotOnLoginPage;

    const loginSuccessful = (hasNavElements || (noLoginForm && isOnCorrectDomain && notOnLoginPage)) && noErrors;

    if (!loginSuccessful) {
      console.log('Failed');
      throw new Error('Failed');
    } else {
      console.log('Success');
      return true;
    }
  } catch (error) {
    console.error('Error:', error);
  }
}
