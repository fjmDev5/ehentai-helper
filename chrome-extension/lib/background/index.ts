chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_DOWNLOAD') {
    setupRefererRules().then(() => {
      startOffscreenDownload(message.payload);
    });
    sendResponse({ status: 'started' });
  } else if (message.type === 'COMPLETE_ZIP') {
    const { url, filename } = message.payload;
    chrome.downloads.download({
      url,
      filename,
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('Download failed to start:', chrome.runtime.lastError);
        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_PROGRESS',
          payload: { status: 'error', error: chrome.runtime.lastError.message }
        }).catch(() => {});
        chrome.offscreen.closeDocument();
        return;
      }

      const checkStatus = (delta: chrome.downloads.DownloadDelta) => {
        if (delta.id === downloadId) {
          if (delta.state?.current === 'complete') {
            chrome.downloads.onChanged.removeListener(checkStatus);
            chrome.runtime.sendMessage({
              type: 'DOWNLOAD_PROGRESS',
              payload: { status: 'completed' }
            }).catch(() => {});
            chrome.offscreen.closeDocument();
          } else if (delta.state?.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(checkStatus);
            console.error('Download interrupted:', delta.error?.current);
            chrome.runtime.sendMessage({
              type: 'DOWNLOAD_PROGRESS',
              payload: { status: 'error', error: `Download interrupted: ${delta.error?.current}` }
            }).catch(() => {});
            chrome.offscreen.closeDocument();
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
        urlFilter: '*',
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: [
          chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
          chrome.declarativeNetRequest.ResourceType.OTHER
        ]
      }
    }
  ];

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
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
