const process = require('process');

function main() {
  if (process.platform !== 'win32') {
    writeResult([]);
    return;
  }

  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const HANDLE = koffi.pointer('HANDLE', koffi.opaque());
  const HWND = koffi.alias('HWND', HANDLE);
  const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(HWND hwnd, long lParam)');
  const RECT = koffi.struct('RECT', {
    left: 'long',
    top: 'long',
    right: 'long',
    bottom: 'long'
  });
  const DWORD = koffi.alias('DWORD', 'uint32_t');

  const api = {
    koffi,
    GW_OWNER: 4,
    GetForegroundWindow: user32.func('HWND __stdcall GetForegroundWindow(void)'),
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(HWND hWnd, _Out_ uint16_t *lpString, int nMaxCount)'),
    GetWindowThreadProcessId: user32.func('DWORD __stdcall GetWindowThreadProcessId(HWND hWnd, _Out_ DWORD *lpdwProcessId)'),
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(HWND hWnd, _Out_ RECT *lpRect)'),
    GetWindow: user32.func('HWND __stdcall GetWindow(HWND hWnd, uint32_t uCmd)'),
    EnumWindows: user32.func('bool __stdcall EnumWindows(EnumWindowsProc *lpEnumFunc, long lParam)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(HWND hWnd)'),
    IsIconic: user32.func('bool __stdcall IsIconic(HWND hWnd)')
  };

  const parentPid = normalizePid(process.env.VDS_PARENT_PROCESS_ID);
  const foregroundHandle = getWindowHandleValue(api, api.GetForegroundWindow());
  const windows = [];
  const enumCallback = (hwnd) => {
    if (!hwnd) {
      return true;
    }

    if (api.GetWindow(hwnd, api.GW_OWNER)) {
      return true;
    }

    const hwndValue = getWindowHandleValue(api, hwnd);
    if (!hwndValue) {
      return true;
    }

    const title = getWindowTitle(api, hwnd);
    if (!title) {
      return true;
    }

    const pid = getWindowProcessId(api, hwnd);
    if (parentPid && pid === parentPid) {
      return true;
    }

    windows.push({
      hwnd: hwndValue,
      pid,
      title,
      rect: getWindowRect(api, hwnd),
      isForeground: foregroundHandle === hwndValue,
      isVisible: Boolean(api.IsWindowVisible(hwnd)),
      isMinimized: Boolean(api.IsIconic(hwnd))
    });

    return true;
  };

  api.EnumWindows(enumCallback, 0);
  writeResult(windows);
}

function writeResult(windows) {
  process.stdout.write(JSON.stringify({ windows: Array.isArray(windows) ? windows : [] }));
}

function getWindowTitle(api, hwnd) {
  const wcharCount = 1024;
  const buffer = Buffer.alloc(wcharCount * 2);
  const length = api.GetWindowTextW(hwnd, buffer, wcharCount);
  if (!length) {
    return '';
  }

  return buffer.toString('utf16le', 0, length * 2).replace(/\0+$/, '').trim();
}

function getWindowProcessId(api, hwnd) {
  const pid = [0];
  const threadId = api.GetWindowThreadProcessId(hwnd, pid);
  if (!threadId || !pid[0]) {
    return 0;
  }

  return Number(pid[0]) || 0;
}

function getWindowHandleValue(api, hwnd) {
  if (!hwnd) {
    return '';
  }
  const value = api.koffi.address(hwnd);
  return value ? value.toString() : '';
}

function getWindowRect(api, hwnd) {
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!api.GetWindowRect(hwnd, rect)) {
    return null;
  }
  return {
    left: Number(rect.left) || 0,
    top: Number(rect.top) || 0,
    right: Number(rect.right) || 0,
    bottom: Number(rect.bottom) || 0
  };
}

function normalizePid(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : 0;
}

try {
  main();
} catch (error) {
  process.stderr.write(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
