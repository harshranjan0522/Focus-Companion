let focusEndTime = 0;
let activeTabTimers = {}; // {tabId: timeoutId}
let currentThreshold = 2;

// --- On install ---
chrome.runtime.onInstalled.addListener(() => console.log("Focus Companion installed"));

// --- Listen for threshold updates ---
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'THRESHOLD_UPDATED') {
        currentThreshold = Number(message.threshold) > 0 ? Number(message.threshold) : 2;
        console.log("Threshold updated to:", currentThreshold);
        initializeTimersForAllDistractingTabs();
    }
});

// --- Handle distracting tab ---
function handleDistractingTab(tab) {
    chrome.storage.local.get(['tabsCategory', 'focusEndTime', 'tabCloseTimes'], data => {
        const tabsCategory = data.tabsCategory || {};
        focusEndTime = data.focusEndTime || 0;
        let tabCloseTimes = data.tabCloseTimes || {};

        // --- Do not close tabs if focus mode ended ---
        if (Date.now() >= focusEndTime) return;

        const key = tab.url || String(tab.id);        // for category
        const timerKey = String(tab.id);              // for timers

        if (tabsCategory[key] !== 'distracting') return;

        const newCloseTime = Date.now() + currentThreshold * 60 * 1000;
        if (!tabCloseTimes[timerKey] || (tabCloseTimes[timerKey] - Date.now()) / 1000 / 60 > currentThreshold) {
            tabCloseTimes[timerKey] = newCloseTime;
            chrome.storage.local.set({ tabCloseTimes });
        }

        if (activeTabTimers[timerKey]) clearTimeout(activeTabTimers[timerKey]);

        const remaining = tabCloseTimes[timerKey] - Date.now();
        if (remaining <= 0) {
            // Prevent auto-close if focus ended
            if (Date.now() < focusEndTime) {
                chrome.tabs.remove(tab.id, () => {});
            }
            delete tabCloseTimes[timerKey];
            chrome.storage.local.set({ tabCloseTimes });
            return;
        }

        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icon.png',
            title: 'Focus Companion',
            message: "You're on a distracting tab!"
        });

        activeTabTimers[timerKey] = setTimeout(() => {
            if (Date.now() < focusEndTime) {       // only close if focus mode is active
                chrome.tabs.remove(tab.id, () => {});
            }
            delete activeTabTimers[timerKey];
            delete tabCloseTimes[timerKey];
            chrome.storage.local.set({ tabCloseTimes });
        }, remaining);
    });
}


// --- Block tab if distracting ---
function blockTab(tabId) {
    chrome.tabs.get(tabId, tab => {
        if (chrome.runtime.lastError || !tab) return;
        handleDistractingTab(tab);
    });
}

// --- Initialize timers for all distracting tabs ---
function initializeTimersForAllDistractingTabs() {
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => blockTab(tab.id));
    });
}

// --- Listen for tab activation & updates ---
chrome.tabs.onActivated.addListener(activeInfo => blockTab(activeInfo.tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') blockTab(tabId);
});

// --- Default new tabs to focus ---
chrome.tabs.onCreated.addListener(tab => {
    chrome.storage.local.get(['tabsCategory'], data => {
        const tabsCategory = data.tabsCategory || {};
        if (!(tab.url in tabsCategory)) {
            tabsCategory[tab.url] = 'focus';
            chrome.storage.local.set({ tabsCategory });
        }
    });
});

// --- Periodically check all distracting tabs ---
setInterval(() => {
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => blockTab(tab.id));
    });
}, 30 * 1000);
