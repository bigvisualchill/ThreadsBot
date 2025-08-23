// Test minimal version
async function testFunction() {
  try {
    console.log("Test");
    
    if (true) {
      console.log("Success");
      return true;
    } else {
      console.log("Failed");
      throw new Error("Failed");
    }
  } catch (error) {
    console.error("Error:", error);
  }
}
