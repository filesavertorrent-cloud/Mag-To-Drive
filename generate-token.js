import Drive from './drive.js';

console.log('\n=========================================');
console.log('🔑 Google Drive Token Generator');
console.log('=========================================\n');
console.log('We are about to open a browser window for you to log in to Google.');
console.log('Please select your Google account and grant the requested permissions...\n');

const drive = new Drive();

drive.authorize().then(client => {
    const refreshToken = client.credentials.refresh_token;

    console.log('\n✅ SUCCESS! Authentication complete.\n');
    console.log('Here is your new Refresh Token for Render:\n');
    console.log('--------------------------------------------------');
    console.log(refreshToken);
    console.log('--------------------------------------------------\n');

    console.log('If you are using GDRIVE_ACCOUNTS (Multi-Account Mode), update your JSON like this:');
    console.log(`[
  {
    "name": "My Google Drive",
    "client_id": "YOUR_CLIENT_ID",
    "client_secret": "YOUR_CLIENT_SECRET",
    "refresh_token": "${refreshToken}"
  }
]\n`);

    console.log('If you are using the old single-account mode, just replace the value of GOOGLE_REFRESH_TOKEN in Render with this new token.\n');

    process.exit(0);
}).catch(err => {
    console.error('\n❌ Authentication failed:', err.message);
    process.exit(1);
});
