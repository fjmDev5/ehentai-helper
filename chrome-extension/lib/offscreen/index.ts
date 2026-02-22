import JSZip from 'jszip';

let fetchedCount = 0;
let totalToFetch = 0;

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.type === 'START_DOWNLOAD_OFFSCREEN') {
    handleDownload(message.payload);
  } else if (message.type === 'CHECK_OFFSCREEN_READY') {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' });
  }
});

// Notify that we are ready
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' });

async function handleDownload(payload: any) {
  const { galleryUrl, galleryInfo, range, galleryPageInfo, config } = payload;
  const [startIndex, endIndex] = range;
  totalToFetch = endIndex - startIndex + 1;
  fetchedCount = 0;
  const zip = new JSZip();

  if (config.saveGalleryInfo) {
    zip.file('info.txt', JSON.stringify(galleryInfo, null, 2));
  }

  const startPage = Math.floor((startIndex - 1) / galleryPageInfo.imagesPerPage);
  const endPage = Math.floor((endIndex - 1) / galleryPageInfo.imagesPerPage);

  try {
    for (let p = startPage; p <= endPage; p++) {
      const pageUrl = `${galleryUrl}?p=${p}`;
      const response = await fetch(pageUrl, { 
        credentials: 'include',
        headers: { 'Referer': 'https://e-hentai.org/' }
      });
      if (!response.ok) throw new Error(`Failed to fetch gallery page ${p}: ${response.statusText}`);
      const html = await response.text();
      const imagePageUrls = extractImagePageUrls(html);
      
      if (imagePageUrls.length === 0) {
        console.warn(`No image page URLs found on page ${p}`);
      }

      for (let i = 0; i < imagePageUrls.length; i++) {
        const currentIndex = p * galleryPageInfo.imagesPerPage + i + 1;
        if (currentIndex < startIndex || currentIndex > endIndex) continue;

        try {
          await downloadImage(zip, imagePageUrls[i], currentIndex, config, galleryPageInfo.totalImages);
        } catch (err) {
          console.error(`Failed to download image ${currentIndex}:`, err);
          // Continue with other images even if one fails
        }
        
        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_PROGRESS',
          payload: { fetchedCount, totalCount: totalToFetch, status: 'downloading' }
        }).catch(() => {});

        if (config.downloadInterval > 0) {
          await new Promise(resolve => setTimeout(resolve, config.downloadInterval));
        }
      }
    }

    if (fetchedCount === 0) {
      throw new Error('No images were successfully downloaded.');
    }

    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_PROGRESS',
      payload: { fetchedCount, totalCount: totalToFetch, status: 'zipping' }
    }).catch(() => {});

    // Use STORE compression for speed as images are already compressed
    const content = await zip.generateAsync({ 
      type: 'blob',
      compression: 'STORE'
    });
    const zipName = `${removeInvalidCharFromFilename(galleryInfo.name)}.zip`;
    const url = URL.createObjectURL(content);

    // Send result to background script as offscreen document cannot call chrome.downloads.download
    chrome.runtime.sendMessage({
      type: 'COMPLETE_ZIP',
      payload: {
        url,
        filename: `${config.intermediateDownloadPath.replace(/\/$/, '')}/${zipName}`
      }
    });

  } catch (error) {
    console.error('Offscreen download failed:', error);
    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_PROGRESS',
      payload: { status: 'error', error: String(error) }
    }).catch(() => {});
  }
}

function extractImagePageUrls(html: string): string[] {
  const urls: string[] = [];
  // More robust regex to handle different E-Hentai gallery layouts (Minimal, Thumbnail, etc.)
  // Looks for any link that matches the image page pattern /s/HASH/INDEX-PAGE
  const sPageRegex = /href=["'](https?:\/\/e[-x]hentai\.org\/s\/[^"']+)["']/g;
  let match;
  while ((match = sPageRegex.exec(html)) !== null) {
    if (!urls.includes(match[1])) {
      urls.push(match[1]);
    }
  }
  return urls;
}

async function downloadImage(zip: JSZip, url: string, index: number, config: any, totalImages: number) {
  const response = await fetch(url, { 
    credentials: 'include',
    headers: { 'Referer': 'https://e-hentai.org/' }
  });
  if (!response.ok) throw new Error(`Failed to fetch image page: ${response.statusText}`);
  const html = await response.text();

  let imageUrl = '';
  // Enhanced regex for image URL extraction
  const imgMatch = /<img[^>]+id=["']img["'][^>]+src=["']([^"']+)["']/i.exec(html) ||
                   /src=["']([^"']+)["'][^>]+id=["']img["']/i.exec(html);
  
  if (imgMatch) {
    imageUrl = imgMatch[1];
  }

  if (config.saveOriginalImages) {
    const originalMatch = /<a[^>]+href=["'](https?:\/\/e[-x]hentai\.org\/fullimg\.php[^"']+)["']/i.exec(html) ||
                         /id=["']i6["'][^>]*>.*?<a[^>]*href=["']([^"']+)["']/s.exec(html);
    if (originalMatch) {
      imageUrl = originalMatch[1] || originalMatch[2];
    }
  }

  if (!imageUrl) {
    throw new Error(`Could not find image URL on page: ${url}`);
  }

  const imageRes = await fetch(imageUrl, { 
    credentials: 'include',
    headers: { 'Referer': url } // Referer should be the image page for image downloads
  });
  if (!imageRes.ok) throw new Error(`Failed to fetch image from ${imageUrl}: ${imageRes.statusText}`);
  const buffer = await imageRes.arrayBuffer();
  
  const urlParts = imageUrl.split('/').pop()?.split('?')[0] || 'image.jpg';
  const lastDotIndex = urlParts.lastIndexOf('.');
  const originalName = lastDotIndex !== -1 ? urlParts.substring(0, lastDotIndex) : urlParts;
  const fileType = lastDotIndex !== -1 ? urlParts.substring(lastDotIndex + 1) : 'jpg';

  const filename = config.fileNameRule
    .replace('[index]', String(index).padStart(String(totalImages).length, '0'))
    .replace('[name]', originalName)
    .replace('[total]', String(totalImages)) + '.' + fileType;

  zip.file(filename, buffer);
  fetchedCount++;
}

function removeInvalidCharFromFilename(filename: string) {
  return filename.replace(/[\\/:*?"<>|.~]/g, ' ').replace(/\s+$/, '');
}
