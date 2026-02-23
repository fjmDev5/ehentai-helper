import { zipSync } from 'fflate';
import pLimit from 'p-limit';

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
  const taskId = galleryUrl;
  const [startIndex, endIndex] = range;
  const totalToFetch = endIndex - startIndex + 1;
  let fetchedCount = 0;
  const zipFiles: Record<string, [Uint8Array, { level: 0 }]> = {};
  const galleryOrigin = new URL(galleryUrl).origin + '/';

  if (config.saveGalleryInfo) {
    const infoText = JSON.stringify(galleryInfo, null, 2);
    zipFiles['info.txt'] = [new TextEncoder().encode(infoText), { level: 0 }];
  }

  const startPage = Math.floor((startIndex - 1) / galleryPageInfo.imagesPerPage);
  const endPage = Math.floor((endIndex - 1) / galleryPageInfo.imagesPerPage);

  try {
    // 1. Fetch all gallery pages in parallel (limited)
    const pageLimit = pLimit(3);
    const pageUrls: string[] = [];
    for (let p = startPage; p <= endPage; p++) {
      pageUrls.push(`${galleryUrl}?p=${p}`);
    }

    const galleryPagesHtml = await Promise.all(
      pageUrls.map(url => 
        pageLimit(async () => {
          const response = await fetch(url, { 
            credentials: 'include',
            headers: { 'Referer': galleryOrigin }
          });
          if (!response.ok) throw new Error(`Failed to fetch gallery page ${url}: ${response.statusText}`);
          return response.text();
        })
      )
    );

    // 2. Extract all image page URLs
    const allImagePageUrls: { url: string, index: number }[] = [];
    galleryPagesHtml.forEach((html, pageIdx) => {
      const p = startPage + pageIdx;
      const urls = extractImagePageUrls(html);
      urls.forEach((url, i) => {
        const currentIndex = p * galleryPageInfo.imagesPerPage + i + 1;
        if (currentIndex >= startIndex && currentIndex <= endIndex) {
          allImagePageUrls.push({ url, index: currentIndex });
        }
      });
    });

    if (allImagePageUrls.length === 0) {
      throw new Error('No image page URLs found in the specified range.');
    }

    // 3. Download images with concurrency limit
    // If downloadInterval is 0, use a reasonable concurrency like 5
    // If downloadInterval > 0, we still use concurrency 1 to be safe, but we could technically do more
    const downloadConcurrency = config.downloadInterval > 0 ? 1 : 5;
    const downloadLimit = pLimit(downloadConcurrency);

    await Promise.all(
      allImagePageUrls.map(({ url, index }) => 
        downloadLimit(async () => {
          try {
            const result = await downloadImage(url, index, config, galleryPageInfo.totalImages, galleryOrigin);
            if (result) {
              zipFiles[result.filename] = [new Uint8Array(result.buffer), { level: 0 }];
              fetchedCount++;
            }
          } catch (err) {
            console.error(`Failed to download image ${index}:`, err);
          }

          chrome.runtime.sendMessage({
            type: 'DOWNLOAD_PROGRESS',
            payload: { taskId, fetchedCount, totalCount: totalToFetch, status: 'downloading' }
          }).catch(() => {});

          if (config.downloadInterval > 0) {
            await new Promise(resolve => setTimeout(resolve, config.downloadInterval));
          }
        })
      )
    );

    if (fetchedCount === 0) {
      throw new Error('No images were successfully downloaded.');
    }

    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_PROGRESS',
      payload: { taskId, fetchedCount, totalCount: totalToFetch, status: 'zipping' }
    }).catch(() => {});

    // 4. Use fflate for fast zipping
    // zipSync is very fast for STORE (level: 0)
    const zipped = zipSync(zipFiles);
    const content = new Blob([zipped], { type: 'application/zip' });
    
    const zipName = `${removeInvalidCharFromFilename(galleryInfo.name).substring(0, 200)}.zip`;
    const url = URL.createObjectURL(content);

    // Send result to background script
    const sanitizedPath = (config.intermediateDownloadPath || '').replace(/[\\:*?"<>|]/g, ' ').replace(/\/+$/, '');
    chrome.runtime.sendMessage({
      type: 'COMPLETE_ZIP',
      payload: {
        taskId,
        url,
        filename: sanitizedPath ? `${sanitizedPath}/${zipName}` : zipName,
        config
      }
    });

  } catch (error) {
    console.error('Offscreen download failed:', error);
    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_PROGRESS',
      payload: { taskId, status: 'error', error: String(error) }
    }).catch(() => {});
  }
}

function extractImagePageUrls(html: string): string[] {
  const urls: string[] = [];
  const sPageRegex = /href=["'](https?:\/\/e[-x]hentai\.org\/s\/[^"']+)["']/g;
  let match;
  while ((match = sPageRegex.exec(html)) !== null) {
    if (!urls.includes(match[1])) {
      urls.push(match[1]);
    }
  }
  return urls;
}

async function downloadImage(url: string, index: number, config: any, totalImages: number, galleryOrigin: string): Promise<{ filename: string, buffer: ArrayBuffer } | null> {
  const response = await fetch(url, { 
    credentials: 'include',
    headers: { 'Referer': galleryOrigin }
  });
  if (!response.ok) throw new Error(`Failed to fetch image page: ${response.statusText}`);
  const html = await response.text();

  let imageUrl = '';
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
    headers: { 'Referer': url }
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

  return { filename, buffer };
}

function removeInvalidCharFromFilename(filename: string) {
  return filename.replace(/[\\/:*?"<>|.~]/g, ' ').replace(/\s+$/, '');
}
