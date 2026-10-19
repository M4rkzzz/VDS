// WGC is damage-driven. A static desktop is not a reliable source for a smoke
// that asserts continued frame growth. This tiny owned window supplies damage
// without moving the user's pointer, activating a window or saving any pixels.
function startCaptureStimulus() {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const gdi = koffi.load('gdi32.dll');
  const createWindow = user32.func('void * __stdcall CreateWindowExW(uint32_t exStyle, str16 cls, str16 title, uint32_t style, int x, int y, int w, int h, void *parent, void *menu, void *instance, void *param)');
  const destroyWindow = user32.func('bool __stdcall DestroyWindow(void *hwnd)');
  const getDc = user32.func('void * __stdcall GetDC(void *hwnd)');
  const releaseDc = user32.func('int __stdcall ReleaseDC(void *hwnd, void *dc)');
  const rect = koffi.struct({ left: 'int', top: 'int', right: 'int', bottom: 'int' });
  const fill = user32.func('FillRect', 'int', ['void *', koffi.pointer(rect), 'void *']);
  const makeBrush = gdi.func('void * __stdcall CreateSolidBrush(uint32_t color)');
  const deleteObject = gdi.func('bool __stdcall DeleteObject(void *object)');
  const window = createWindow(0x08000088, 'STATIC', 'VDS owned capture stimulus',
    0x90000000, 0, 0, 16, 16, null, null, null, null);
  if (!window) throw new Error('capture-stimulus-window-create-failed');
  const brushes = [makeBrush(0x202020), makeBrush(0x808080)];
  let tick = 0;
  const timer = setInterval(() => {
    const dc = getDc(window);
    if (!dc) return;
    try { fill(dc, { left: 0, top: 0, right: 16, bottom: 16 }, brushes[tick++ % 2]); }
    finally { releaseDc(window, dc); }
  }, 33);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    destroyWindow(window);
    for (const brush of brushes) if (brush) deleteObject(brush);
  };
}

module.exports = { startCaptureStimulus };
