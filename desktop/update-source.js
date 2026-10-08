const TRUSTED_UPDATE_FEED_URL = 'https://boshan.s.3q.hair/updates/';

function getUpdateFeedBaseUrl(isPackaged, environment = process.env) {
  // Signaling may use a LAN server. Installed software updates have a separate trust boundary.
  if (isPackaged) return TRUSTED_UPDATE_FEED_URL;
  const url = new URL(environment.VDS_UPDATE_URL || TRUSTED_UPDATE_FEED_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('update-feed-must-use-https');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.href;
}

module.exports = { TRUSTED_UPDATE_FEED_URL, getUpdateFeedBaseUrl };
