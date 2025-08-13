# Tuva Terminology Viewer

This application is for viewing the terminology data publicly available from The Tuva Project.

# Testing Locally

1. In Terminal `cd csv_viewer_app` to go to that folder.
2. Run `npm start` to start the server.
3. Click on the provided link to open the page.

# Deploying to Github Pages
WARNING: This will deploy the build to the active public URL. Do not use this for testing! Ensure that everything works!
1. run `npm build`
2. run `npm run deploy`

## Requirements for deployment

1. Install the `gh-pages` package. `npm install --save-dev gh-pages`
2. Enable GitHub Pages in Repository Settings  
   - Go to your repository on GitHub (e.g., https://github.com/username/repo-name).
   - Click on Settings.
   - Ensure your repo is public, otherwise you cannot share this via pages.
   - Scroll to the Pages section.
   - Under Source, select the gh-pages branch and set the folder to / (root).
   - Click Save.
