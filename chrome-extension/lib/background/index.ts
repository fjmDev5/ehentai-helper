const activeTasks = new Set<string>();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_DOWNLOAD') {
    const { galleryUrl } = message.payload;
    activeTasks.add(galleryUrl);
    setupRefererRules().then(() => {
      startOffscreenDownload(message.payload);
    });
    sendResponse({ status: 'started' });
  } else if (message.type === 'CHECK_TASK_STATUS') {
    const { galleryUrl } = message.payload;
    sendResponse({ isDownloading: activeTasks.has(galleryUrl) });
  } else if (message.type === 'DOWNLOAD_PROGRESS') {
    if (message.payload.status === 'error') {
      const { taskId } = message.payload;
      activeTasks.delete(taskId);
      if (activeTasks.size === 0) {
        chrome.offscreen.closeDocument().catch(() => {});
      }
    }
  } else if (message.type === 'COMPLETE_ZIP') {
    const { url, filename, taskId, config } = message.payload;
    // Ensure filename doesn't start with a slash, which can cause issues on some systems
    const normalizedFilename = filename.replace(/^[\\\/]+/, '');
    
    chrome.downloads.download({
      url,
      filename: normalizedFilename,
      saveAs: false,
      conflictAction: config?.filenameConflictAction || 'uniquify'
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        const errorMsg = chrome.runtime.lastError.message || 'Unknown error';
        console.error(`Download failed to start for ${normalizedFilename}:`, errorMsg);
        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_PROGRESS',
          payload: { taskId, status: 'error', error: errorMsg }
        }).catch(() => {});
        
        activeTasks.delete(taskId);
        if (activeTasks.size === 0) {
          chrome.offscreen.closeDocument().catch(() => {});
        }
        return;
      }

      const checkStatus = (delta: chrome.downloads.DownloadDelta) => {
        if (delta.id === downloadId) {
          if (delta.state?.current === 'complete') {
            chrome.downloads.onChanged.removeListener(checkStatus);
            chrome.runtime.sendMessage({
              type: 'DOWNLOAD_PROGRESS',
              payload: { taskId, status: 'completed' }
            }).catch(() => {});

            activeTasks.delete(taskId);
            if (activeTasks.size === 0) {
              chrome.offscreen.closeDocument().catch(() => {});
            }
          } else if (delta.state?.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(checkStatus);
            console.error('Download interrupted:', delta.error?.current);
            chrome.runtime.sendMessage({
              type: 'DOWNLOAD_PROGRESS',
              payload: { taskId, status: 'error', error: `Download interrupted: ${delta.error?.current}` }
            }).catch(() => {});

            activeTasks.delete(taskId);
            if (activeTasks.size === 0) {
              chrome.offscreen.closeDocument().catch(() => {});
            }
          }
        }
      };
      chrome.downloads.onChanged.addListener(checkStatus);
    });
  }
  return true;
});

async function setupRefererRules() {
  const rules: chrome.declarativeNetRequest.Rule[] = [
    {
      id: 1,
      priority: 1,
      action: {
        type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
        requestHeaders: [
          {
            header: 'Referer',
            operation: chrome.declarativeNetRequest.HeaderOperation.SET,
            value: 'https://e-hentai.org/'
          }
        ]
      },
      condition: {
        urlFilter: '*://e-hentai.org/*',
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: [
          chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
          chrome.declarativeNetRequest.ResourceType.OTHER
        ]
      }
    },
    {
      id: 2,
      priority: 1,
      action: {
        type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
        requestHeaders: [
          {
            header: 'Referer',
            operation: chrome.declarativeNetRequest.HeaderOperation.SET,
            value: 'https://exhentai.org/'
          }
        ]
      },
      condition: {
        urlFilter: '*://exhentai.org/*',
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: [
          chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
          chrome.declarativeNetRequest.ResourceType.OTHER
        ]
      }
    }
  ];

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1, 2],
    addRules: rules
  });
}

async function startOffscreenDownload(payload: any) {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
  });

  if (existingContexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: 'Generate and download ZIP files'
    });
  }

  // Wait for the offscreen document to be ready
  const isReady = await checkOffscreenReady();
  if (isReady) {
    chrome.runtime.sendMessage({
      type: 'START_DOWNLOAD_OFFSCREEN',
      payload
    });
  } else {
    console.error('Offscreen document failed to become ready');
  }
}

function checkOffscreenReady(): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      resolve(false);
    }, 5000);

    const listener = (message: any) => {
      if (message.type === 'OFFSCREEN_READY') {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(true);
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    chrome.runtime.sendMessage({ type: 'CHECK_OFFSCREEN_READY' }).catch(() => {
      // Ignore errors if offscreen is not yet listening
    });
  });
}
