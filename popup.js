document.addEventListener('DOMContentLoaded', () => {
  if (Notification.permission !== "granted") Notification.requestPermission();

  const toggleFocusBtn = document.getElementById('toggle-focus');
  const thresholdInput = document.getElementById('threshold');
  const tabList = document.getElementById('tabList');
  const toggleThemeBtn = document.getElementById('toggle-theme');
  const resetBtn = document.getElementById('reset-settings');
  const refreshBtn = document.getElementById('categorize-tabs');

  let globalTimerSpan = document.createElement('div');
  globalTimerSpan.id = 'global-focus-timer';
  globalTimerSpan.style.margin = '8px 0';
  tabList.parentNode.insertBefore(globalTimerSpan, tabList);

  if (!tabList) return;

  let focusMode = false;
  let tabsCategory = {};
  let threshold = 2;
  let theme = 'light';
  let tabCloseTimes = {};
  let timerIntervals = {};
  let globalInterval;

  chrome.storage.local.get(['focusMode', 'tabsCategory', 'threshold', 'theme', 'tabCloseTimes', 'focusEndTime'], data => {
    focusMode = !!data.focusMode;
    tabsCategory = data.tabsCategory || {};
    threshold = Number(data.threshold) > 0 ? Number(data.threshold) : 2;
    thresholdInput.value = threshold;
    theme = data.theme || 'light';
    document.body.className = theme;
    tabCloseTimes = data.tabCloseTimes || {};
    updateToggleFocusBtn();
    displayTabs();
    startGlobalTimer(data.focusEndTime || 0);
  });

  toggleFocusBtn.addEventListener('click', () => {
    if (!focusMode) {
      const userTime = parseInt(prompt("Enter focus time in minutes:"), 10);
      if (isNaN(userTime) || userTime <= 0) return alert("Invalid time");

      const endTime = Date.now() + userTime * 60 * 1000;
      chrome.storage.local.set({ focusEndTime: endTime, focusMode: true }, () => {
        focusMode = true;
        updateToggleFocusBtn();
        displayTabs();
        startGlobalTimer(endTime);
      });
    } else {
      focusMode = false;
      chrome.storage.local.set({ focusMode, focusEndTime: 0 });
      updateToggleFocusBtn();
      stopAllTimers();
      displayTabs();
      clearInterval(globalInterval);
      globalTimerSpan.textContent = '';
    }
  });

  thresholdInput.addEventListener('change', () => {
    const v = parseInt(thresholdInput.value, 10);
    if (!isNaN(v) && v > 0) {
      threshold = v;
      chrome.storage.local.set({ threshold }, () => {
        chrome.runtime.sendMessage({ type: 'THRESHOLD_UPDATED', threshold: v });
      });
      displayTabs();
    }
  });

  toggleThemeBtn.addEventListener('click', () => {
    theme = theme === 'light' ? 'dark' : 'light';
    document.body.className = theme;
    chrome.storage.local.set({ theme });
  });

  resetBtn.addEventListener('click', () => {
    focusMode = false;
    tabsCategory = {};
    threshold = 2;
    theme = 'light';
    tabCloseTimes = {};
    stopAllTimers();
    clearInterval(globalInterval);
    globalTimerSpan.textContent = '';
    thresholdInput.value = threshold;
    document.body.className = theme;
    updateToggleFocusBtn();
    chrome.storage.local.set({ focusMode, tabsCategory, threshold, theme, focusEndTime:0, tabCloseTimes:{} }, displayTabs);
  });

  refreshBtn.addEventListener('click', () => {
    displayTabs();
  });

  function stopAllTimers() {
    Object.values(timerIntervals).forEach(interval => clearInterval(interval));
    timerIntervals = {};
  }

  function updateToggleFocusBtn() {
    toggleFocusBtn.textContent = focusMode ? 'Deactivate Focus Mode' : 'Activate Focus Mode';
  }

  function startGlobalTimer(endTime) {
    clearInterval(globalInterval);
    if (!endTime || endTime <= Date.now()) {
        globalTimerSpan.textContent = '';
        return;
    }
    globalInterval = setInterval(() => {
        const diff = Math.max(0, Math.floor((endTime - Date.now()) / 1000));
        const min = Math.floor(diff / 60);
        const sec = diff % 60;
        globalTimerSpan.textContent = `Focus time remaining: ${min}m ${sec}s`;

        if (diff <= 0) {
            clearInterval(globalInterval);
            globalTimerSpan.textContent = '';

            // --- Deactivate focus mode and stop all timers ---
            focusMode = false;
            stopAllTimers();
            updateToggleFocusBtn();
            chrome.storage.local.set({ focusMode: false, focusEndTime: 0 });
        }
    }, 1000);
  }
  
  function displayTabs() {
    stopAllTimers();
    chrome.tabs.query({}, (tabs) => {
      chrome.storage.local.get(['tabsCategory', 'tabCloseTimes', 'focusEndTime'], data => {
        tabsCategory = data.tabsCategory || {};
        tabCloseTimes = data.tabCloseTimes || {};
        const focusEnd = data.focusEndTime || 0;
        tabList.innerHTML = '';

        tabs.forEach(tab => {
          const key = tab.url;           // category by URL
          const timerKey = String(tab.id); // timer by tab ID

          if (!(key in tabsCategory)) tabsCategory[key] = 'focus';

          const tabItem = document.createElement('div');
          tabItem.className = 'tab-item';

          const title = document.createElement('span');
          title.className = 'tab-title';
          title.textContent = tab.title || tab.url || 'Untitled';

          const btnGroup = document.createElement('div');
          btnGroup.className = 'tab-btn-group';

          const focusBtn = document.createElement('button');
          focusBtn.textContent = 'Focus';
          focusBtn.classList.add('focus-btn');
          if (tabsCategory[key] === 'focus') focusBtn.classList.add('active');

          const distractBtn = document.createElement('button');
          distractBtn.textContent = 'Distracting';
          distractBtn.classList.add('distract-btn');
          if (tabsCategory[key] === 'distracting') distractBtn.classList.add('active');

          const timerSpan = document.createElement('span');
          timerSpan.className = 'tab-timer';
          tabItem.appendChild(timerSpan);

          // --- Updated: Only start timer if focus mode is active ---
          if (focusMode && tabsCategory[key] === 'distracting' && Date.now() < focusEnd) {
            if (!tabCloseTimes[timerKey]) {
              tabCloseTimes[timerKey] = Date.now() + threshold * 60 * 1000;
              chrome.storage.local.set({ tabCloseTimes });
            }

            timerIntervals[timerKey] = setInterval(() => {
              const diff = Math.max(0, Math.floor((tabCloseTimes[timerKey] - Date.now()) / 1000));
              const min = Math.floor(diff / 60);
              const sec = diff % 60;
              timerSpan.textContent = `${min}m ${sec}s`;
              if (diff <= 0) {
                clearInterval(timerIntervals[timerKey]);
                timerSpan.textContent = '0m 0s';
              }
            }, 1000);
          } else {
            timerSpan.textContent = '';
            if (timerIntervals[timerKey]) {
              clearInterval(timerIntervals[timerKey]);
              delete timerIntervals[timerKey];
            }
          }

          focusBtn.addEventListener('click', () => {
            tabsCategory[key] = 'focus';
            delete tabCloseTimes[timerKey];
            chrome.storage.local.set({ tabsCategory, tabCloseTimes }, displayTabs);
          });

          distractBtn.addEventListener('click', () => {
            tabsCategory[key] = 'distracting';
            chrome.storage.local.set({ tabsCategory }, displayTabs);
          });

          btnGroup.appendChild(focusBtn);
          btnGroup.appendChild(distractBtn);
          tabItem.appendChild(title);
          tabItem.appendChild(btnGroup);
          tabList.appendChild(tabItem);
        });

        chrome.storage.local.set({ tabsCategory, tabCloseTimes });
      });
    });
  }
});
