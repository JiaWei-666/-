/**
 * AI Image Inpainting Tool
 * TensorFlow.js powered, browser-only image object removal
 */
(function () {
  'use strict';

  /* ============================================================
   *  CONFIG
   * ============================================================ */
  var CFG = {
    MAX_DIM: 2048,
    TFJS_URL: 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.17.0/dist/tf.min.js',
    MASK_COLOR: 'rgba(255, 60, 60, 0.45)',
    MASK_STROKE: 'rgba(255, 60, 60, 0.8)',
    INPAINT_RADIUS: 12,
    POST_BLUR_PASSES: 3,
    CHUNK_SIZE: 5000
  };

  /* ============================================================
   *  STATE
   * ============================================================ */
  var S = {
    img: null,
    imgW: 0,
    imgH: 0,
    scale: 1,
    displayW: 0,
    displayH: 0,
    originalData: null,
    currentData: null,
    mask: null,
    maskStrokes: [],
    currentStroke: null,
    brushSize: 20,
    tool: 'brush',
    isDrawing: false,
    rectStart: null,
    tfReady: false,
    tf: null,
    processing: false,
    hasResult: false
  };

  /* ============================================================
   *  DOM REFS
   * ============================================================ */
  var DOM = {};
  function cacheDom() {
    var ids = [
      'uploadBtn','fileInput','brushSize','brushSizeVal',
      'brushTool','rectTool','undoBtn','clearMaskBtn',
      'processBtn','saveBtn','mainCanvas','maskCanvas',
      'canvasWrap','canvasArea','placeholder','statusDot',
      'statusText','progressTrack','progressFill','brushCursor','toast'
    ];
    ids.forEach(function (id) { DOM[id] = document.getElementById(id); });
  }

  /* ============================================================
   *  TOAST & STATUS
   * ============================================================ */
  var toastTimer = null;
  function toast(msg, ms) {
    DOM.toast.textContent = msg;
    DOM.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { DOM.toast.classList.remove('show'); }, ms || 2500);
  }

  function setStatus(text, state) {
    DOM.statusText.textContent = text;
    DOM.statusDot.className = 'status-dot' + (state ? ' ' + state : '');
  }

  function showProgress(pct) {
    DOM.progressTrack.style.display = 'block';
    DOM.progressFill.style.width = Math.min(100, Math.max(0, pct)) + '%';
  }

  function hideProgress() {
    DOM.progressTrack.style.display = 'none';
    DOM.progressFill.style.width = '0%';
  }

  /* ============================================================
   *  TENSORFLOW.JS LOADER
   * ============================================================ */
  function loadTF() {
    return new Promise(function (resolve, reject) {
      if (window.tf) { S.tf = window.tf; resolve(); return; }
      var s = document.createElement('script');
      s.src = CFG.TFJS_URL;
      s.onload = function () {
        if (window.tf) {
          S.tf = window.tf;
          S.tf.ready().then(function () {
            S.tfReady = true;
            resolve();
          }).catch(function () { resolve(); });
        } else { resolve(); }
      };
      s.onerror = function () { resolve(); };
      document.head.appendChild(s);
    });
  }

  /* ============================================================
   *  CANVAS SETUP
   * ============================================================ */
  function setupCanvases() {
    var area = DOM.canvasArea;
    var aW = area.clientWidth - 32;
    var aH = area.clientHeight - 32;
    var imgW = S.imgW, imgH = S.imgH;

    S.scale = Math.min(aW / imgW, aH / imgH, 1);
    S.displayW = Math.round(imgW * S.scale);
    S.displayH = Math.round(imgH * S.scale);

    DOM.mainCanvas.width = S.displayW;
    DOM.mainCanvas.height = S.displayH;
    DOM.maskCanvas.width = S.displayW;
    DOM.maskCanvas.height = S.displayH;

    DOM.canvasWrap.style.width = S.displayW + 'px';
    DOM.canvasWrap.style.height = S.displayH + 'px';
    DOM.canvasWrap.style.display = 'block';

    var ctx = DOM.mainCanvas.getContext('2d');
    ctx.drawImage(S.img, 0, 0, S.displayW, S.displayH);
    S.originalData = ctx.getImageData(0, 0, S.displayW, S.displayH);
    S.currentData = new ImageData(
      new Uint8ClampedArray(S.originalData.data),
      S.displayW, S.displayH
    );

    S.mask = new Uint8Array(S.displayW * S.displayH);
    clearMaskCanvas();
  }

  function clearMaskCanvas() {
    var ctx = DOM.maskCanvas.getContext('2d');
    ctx.clearRect(0, 0, S.displayW, S.displayH);
  }

  function redrawMask() {
    clearMaskCanvas();
    var ctx = DOM.maskCanvas.getContext('2d');
    ctx.fillStyle = CFG.MASK_COLOR;
    ctx.strokeStyle = CFG.MASK_STROKE;
    ctx.lineWidth = 1;

    S.maskStrokes.forEach(function (stroke) {
      if (stroke.type === 'brush') {
        drawBrushStroke(ctx, stroke);
      } else if (stroke.type === 'rect') {
        ctx.fillRect(stroke.x, stroke.y, stroke.w, stroke.h);
      }
    });
    updateMaskArray();
  }

  function drawBrushStroke(ctx, stroke) {
    if (stroke.points.length < 2) return;
    ctx.beginPath();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = stroke.size;
    ctx.strokeStyle = CFG.MASK_COLOR;
    ctx.moveTo(stroke.points[0][0], stroke.points[0][1]);
    for (var i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i][0], stroke.points[i][1]);
    }
    ctx.stroke();
  }

  function updateMaskArray() {
    var ctx = DOM.maskCanvas.getContext('2d');
    var maskData = ctx.getImageData(0, 0, S.displayW, S.displayH);
    for (var i = 0; i < S.mask.length; i++) {
      S.mask[i] = maskData.data[i * 4 + 3] > 30 ? 1 : 0;
    }
  }

  /* ============================================================
   *  BRUSH TOOL
   * ============================================================ */
  function getPos(e) {
    var rect = DOM.maskCanvas.getBoundingClientRect();
    var x, y;
    if (e.touches && e.touches.length > 0) {
      x = e.touches[0].clientX - rect.left;
      y = e.touches[0].clientY - rect.top;
    } else {
      x = e.clientX - rect.left;
      y = e.clientY - rect.top;
    }
    return [Math.round(x), Math.round(y)];
  }

  function onPointerDown(e) {
    if (S.processing || !S.img) return;
    e.preventDefault();
    var pos = getPos(e);

    if (S.tool === 'brush') {
      S.isDrawing = true;
      S.currentStroke = { type: 'brush', size: S.brushSize * S.scale, points: [pos] };
    } else if (S.tool === 'rect') {
      S.isDrawing = true;
      S.rectStart = pos;
    }
  }

  function onPointerMove(e) {
    if (!S.isDrawing || S.processing) return;
    e.preventDefault();
    var pos = getPos(e);

    if (S.tool === 'brush' && S.currentStroke) {
      S.currentStroke.points.push(pos);
      var ctx = DOM.maskCanvas.getContext('2d');
      var pts = S.currentStroke.points;
      if (pts.length >= 2) {
        ctx.beginPath();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = S.currentStroke.size;
        ctx.strokeStyle = CFG.MASK_COLOR;
        ctx.moveTo(pts[pts.length - 2][0], pts[pts.length - 2][1]);
        ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
        ctx.stroke();
      }
    } else if (S.tool === 'rect' && S.rectStart) {
      clearMaskCanvas();
      var ctx2 = DOM.maskCanvas.getContext('2d');
      ctx2.fillStyle = CFG.MASK_COLOR;
      var rx = Math.min(S.rectStart[0], pos[0]);
      var ry = Math.min(S.rectStart[1], pos[1]);
      var rw = Math.abs(pos[0] - S.rectStart[0]);
      var rh = Math.abs(pos[1] - S.rectStart[1]);
      ctx2.fillRect(rx, ry, rw, rh);
    }
  }

  function onPointerUp(e) {
    if (!S.isDrawing) return;
    e.preventDefault();

    if (S.tool === 'rect' && S.rectStart) {
      var pos = getPos(e.changedTouches ? e.changedTouches[0] : e);
      var rx = Math.min(S.rectStart[0], pos[0]);
      var ry = Math.min(S.rectStart[1], pos[1]);
      var rw = Math.abs(pos[0] - S.rectStart[0]);
      var rh = Math.abs(pos[1] - S.rectStart[1]);
      if (rw > 2 && rh > 2) {
        S.maskStrokes.push({ type: 'rect', x: rx, y: ry, w: rw, h: rh });
      }
      S.rectStart = null;
      redrawMask();
    } else if (S.tool === 'brush' && S.currentStroke) {
      if (S.currentStroke.points.length > 1) {
        S.maskStrokes.push(S.currentStroke);
      }
      S.currentStroke = null;
      updateMaskArray();
    }

    S.isDrawing = false;
    updateButtons();
  }

  /* brush cursor */
  function updateBrushCursor(e) {
    if (S.tool !== 'brush' || !S.img) {
      DOM.brushCursor.style.display = 'none';
      return;
    }
    DOM.brushCursor.style.display = 'block';
    var size = S.brushSize * S.scale;
    DOM.brushCursor.style.width = size + 'px';
    DOM.brushCursor.style.height = size + 'px';
    DOM.brushCursor.style.left = e.clientX + 'px';
    DOM.brushCursor.style.top = e.clientY + 'px';
  }

  /* ============================================================
   *  INPAINTING ENGINE
   * ============================================================ */

  /** Distance transform (approximate) */
  function distanceTransform(mask, w, h) {
    var dist = new Float32Array(w * h);
    var i, x, y;
    for (i = 0; i < w * h; i++) dist[i] = mask[i] ? 0 : 1e6;

    for (y = 1; y < h; y++) {
      for (x = 1; x < w - 1; x++) {
        i = y * w + x;
        if (!mask[i]) continue;
        dist[i] = Math.min(
          dist[i],
          dist[i - 1] + 1,
          dist[i - w] + 1,
          dist[i - w - 1] + 1.414,
          dist[i - w + 1] + 1.414
        );
      }
    }
    for (y = h - 2; y >= 1; y--) {
      for (x = w - 2; x >= 1; x--) {
        i = y * w + x;
        if (!mask[i]) continue;
        dist[i] = Math.min(
          dist[i],
          dist[i + 1] + 1,
          dist[i + w] + 1,
          dist[i + w + 1] + 1.414,
          dist[i + w - 1] + 1.414
        );
      }
    }
    return dist;
  }

  /** Core inpainting: priority-based diffusion */
  function inpaintRegion(data, mask, w, h) {
    var dist = distanceTransform(mask, w, h);
    var maxDist = 0;
    var i;
    for (i = 0; i < w * h; i++) {
      if (mask[i] && dist[i] > maxDist) maxDist = dist[i];
    }

    /* build ordered pixel list by distance (nearest to boundary first) */
    var buckets = [];
    var nBuckets = Math.ceil(maxDist) + 1;
    for (i = 0; i < nBuckets; i++) buckets.push([]);
    for (i = 0; i < w * h; i++) {
      if (mask[i]) {
        var b = Math.min(Math.floor(dist[i]), nBuckets - 1);
        buckets[b].push(i);
      }
    }

    var filled = new Uint8Array(w * h);
    for (i = 0; i < w * h; i++) filled[i] = mask[i] ? 0 : 1;

    var winR = CFG.INPAINT_RADIUS;
    var result = new Uint8ClampedArray(data);

    for (var b = 0; b < nBuckets; b++) {
      var bucket = buckets[b];
      for (var bi = 0; bi < bucket.length; bi++) {
        var pi = bucket[bi];
        var py = (pi / w) | 0;
        var px = pi % w;

        var rSum = 0, gSum = 0, bSum = 0, wSum = 0;
        var y0 = Math.max(0, py - winR), y1 = Math.min(h - 1, py + winR);
        var x0 = Math.max(0, px - winR), x1 = Math.min(w - 1, px + winR);

        for (var ny = y0; ny <= y1; ny++) {
          for (var nx = x0; nx <= x1; nx++) {
            var ni = ny * w + nx;
            if (!filled[ni]) continue;
            var dx = nx - px, dy = ny - py;
            var d2 = dx * dx + dy * dy;
            if (d2 === 0) d2 = 0.01;
            var wt = 1.0 / d2;
            var idx3 = ni * 4;
            rSum += result[idx3] * wt;
            gSum += result[idx3 + 1] * wt;
            bSum += result[idx3 + 2] * wt;
            wSum += wt;
          }
        }

        if (wSum > 0) {
          var idx3 = pi * 4;
          result[idx3] = (rSum / wSum + 0.5) | 0;
          result[idx3 + 1] = (gSum / wSum + 0.5) | 0;
          result[idx3 + 2] = (bSum / wSum + 0.5) | 0;
          result[idx3 + 3] = 255;
        }
        filled[pi] = 1;
      }
    }
    return result;
  }

  /** Post-process: Gaussian-like smoothing on filled region */
  function postProcess(result, origMask, w, h) {
    if (!S.tfReady || !S.tf) return result;
    var tf = S.tf;

    try {
      return tf.tidy(function () {
        var imgT = tf.tensor3d(result, [h, w, 3]).toFloat().div(255);
        var maskT = tf.tensor2d(origMask, [h, w]).toFloat();

        /* feathered mask via average pooling */
        var mask4d = maskT.reshape([1, h, w, 1]);
        var kernel = tf.ones([5, 5, 1, 1]).div(25);
        var feathered = tf.conv2d(mask4d, kernel, 1, 'same').reshape([h, w]);

        /* light gaussian blur on the image */
        var img4d = imgT.expandDims(0);
        var gKernel = tf.tensor4d(
          [1,4,6,4,1, 4,16,24,16,4, 6,24,36,24,6, 4,16,24,16,4, 1,4,6,4,1].map(function(v){return v/256;}),
          [5, 5, 1, 1]
        );
        var channels = tf.split(img4d, 3, 3);
        var blurred = channels.map(function (ch) {
          return tf.conv2d(ch, gKernel, 1, 'same');
        });
        var smooth = tf.concat(blurred, 3).squeeze();

        /* blend: use feathered mask to merge blurred (in masked area) with original */
        var blended = tf.add(
          tf.mul(smooth, feathered),
          tf.mul(imgT, tf.sub(1, feathered))
        );

        var out = blended.mul(255).clipByValue(0, 255).round();
        var outData = out.dataSync();

        var final = new Uint8ClampedArray(w * h * 4);
        for (var i = 0; i < w * h; i++) {
          final[i * 4] = outData[i * 3];
          final[i * 4 + 1] = outData[i * 3 + 1];
          final[i * 4 + 2] = outData[i * 3 + 2];
          final[i * 4 + 3] = 255;
        }
        return final;
      });
    } catch (e) {
      console.warn('TF post-process failed, using fallback:', e);
      return result;
    }
  }

  /** Fallback blur without TF */
  function fallbackBlur(data, mask, w, h) {
    var result = new Uint8ClampedArray(data);
    var r = 3;
    for (var pass = 0; pass < CFG.POST_BLUR_PASSES; pass++) {
      for (var y = r; y < h - r; y++) {
        for (var x = r; x < w - r; x++) {
          var i = y * w + x;
          if (!mask[i]) continue;
          var rS = 0, gS = 0, bS = 0, cnt = 0;
          for (var dy = -r; dy <= r; dy++) {
            for (var dx = -r; dx <= r; dx++) {
              var ni = ((y + dy) * w + (x + dx)) * 4;
              rS += data[ni]; gS += data[ni + 1]; bS += data[ni + 2]; cnt++;
            }
          }
          var idx = i * 4;
          result[idx] = (rS / cnt + 0.5) | 0;
          result[idx + 1] = (gS / cnt + 0.5) | 0;
          result[idx + 2] = (bS / cnt + 0.5) | 0;
        }
      }
      if (pass < CFG.POST_BLUR_PASSES - 1) {
        data = new Uint8ClampedArray(result);
      }
    }
    return result;
  }

  /** Main inpaint pipeline */
  async function runInpaint() {
    if (S.processing) return;
    var hasMask = false;
    for (var i = 0; i < S.mask.length; i++) {
      if (S.mask[i]) { hasMask = true; break; }
    }
    if (!hasMask) { toast('请先用画笔标记要消除的区域'); return; }

    S.processing = true;
    DOM.processBtn.disabled = true;
    setStatus('AI 正在处理...', 'working');
    showProgress(0);

    var w = S.displayW, h = S.displayH;
    var srcData = new Uint8ClampedArray(S.currentData.data);
    var maskCopy = new Uint8Array(S.mask);

    await yieldFrame();
    showProgress(10);

    /* Step 1: core inpainting */
    var result = inpaintRegion(srcData, maskCopy, w, h);
    showProgress(60);
    await yieldFrame();

    /* Step 2: post-processing */
    var final;
    if (S.tfReady) {
      final = postProcess(result, maskCopy, w, h);
    } else {
      final = fallbackBlur(result, maskCopy, w, h);
    }
    showProgress(90);
    await yieldFrame();

    /* Step 3: write result */
    S.currentData = new ImageData(final, w, h);
    var ctx = DOM.mainCanvas.getContext('2d');
    ctx.putImageData(S.currentData, 0, 0);

    /* clear mask */
    S.maskStrokes = [];
    S.mask = new Uint8Array(w * h);
    clearMaskCanvas();

    showProgress(100);
    await yieldFrame();
    hideProgress();

    S.processing = false;
    S.hasResult = true;
    DOM.processBtn.disabled = false;
    setStatus('处理完成 · ' + w + ' x ' + h, 'ready');
    updateButtons();
    toast('消除完成！可继续标记或保存');
  }

  function yieldFrame() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () { setTimeout(resolve, 0); });
    });
  }

  /* ============================================================
   *  UI HANDLERS
   * ============================================================ */
  function updateButtons() {
    var hasMask = false;
    for (var i = 0; i < S.mask.length; i++) {
      if (S.mask[i]) { hasMask = true; break; }
    }
    DOM.processBtn.disabled = S.processing || !hasMask;
    DOM.saveBtn.disabled = !S.hasResult && !S.img;
  }

  function onUpload() {
    DOM.fileInput.click();
  }

  function onFileChange(e) {
    var file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('请选择图片文件');
      return;
    }

    setStatus('正在加载图片...', 'working');
    var reader = new FileReader();
    reader.onload = function (ev) {
      var img = new Image();
      img.onload = function () {
        S.img = img;
        S.imgW = img.naturalWidth;
        S.imgH = img.naturalHeight;
        S.hasResult = false;
        S.maskStrokes = [];

        DOM.placeholder.style.display = 'none';
        setupCanvases();
        updateButtons();
        setStatus('已加载 ' + S.imgW + ' x ' + S.imgH + ' · 请用画笔标记要消除的区域', 'ready');
        toast('图片加载成功');
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
    DOM.fileInput.value = '';
  }

  function onBrushSizeChange() {
    S.brushSize = parseInt(DOM.brushSize.value, 10);
    DOM.brushSizeVal.textContent = S.brushSize;
  }

  function setTool(name) {
    S.tool = name;
    DOM.brushTool.classList.toggle('active', name === 'brush');
    DOM.rectTool.classList.toggle('active', name === 'rect');
    DOM.maskCanvas.style.cursor = name === 'brush' ? 'none' : 'crosshair';
    DOM.brushCursor.style.display = (name === 'brush' && S.img) ? 'block' : 'none';
  }

  function undo() {
    if (S.maskStrokes.length === 0) return;
    S.maskStrokes.pop();
    redrawMask();
    updateButtons();
  }

  function clearMask() {
    S.maskStrokes = [];
    S.mask = new Uint8Array(S.displayW * S.displayH);
    clearMaskCanvas();
    updateButtons();
  }

  function saveImage() {
    if (!S.img) return;
    var link = document.createElement('a');
    link.download = 'inpainted_' + Date.now() + '.png';
    var tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = S.displayW;
    tmpCanvas.height = S.displayH;
    var ctx = tmpCanvas.getContext('2d');
    ctx.putImageData(S.currentData, 0, 0);
    link.href = tmpCanvas.toDataURL('image/png');
    link.click();
    toast('图片已保存');
  }

  /* ============================================================
   *  WINDOW RESIZE
   * ============================================================ */
  var resizeTimer;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (!S.img) return;
      var savedMask = S.maskStrokes.slice();
      setupCanvases();
      S.maskStrokes = savedMask;
      redrawMask();
    }, 200);
  }

  /* ============================================================
   *  INIT
   * ============================================================ */
  function init() {
    cacheDom();

    /* events */
    DOM.uploadBtn.addEventListener('click', onUpload);
    DOM.fileInput.addEventListener('change', onFileChange);
    DOM.brushSize.addEventListener('input', onBrushSizeChange);
    DOM.brushTool.addEventListener('click', function () { setTool('brush'); });
    DOM.rectTool.addEventListener('click', function () { setTool('rect'); });
    DOM.undoBtn.addEventListener('click', undo);
    DOM.clearMaskBtn.addEventListener('click', clearMask);
    DOM.processBtn.addEventListener('click', runInpaint);
    DOM.saveBtn.addEventListener('click', saveImage);

    /* canvas pointer events */
    var mc = DOM.maskCanvas;
    mc.addEventListener('mousedown', onPointerDown);
    mc.addEventListener('mousemove', function (e) { onPointerMove(e); updateBrushCursor(e); });
    mc.addEventListener('mouseup', onPointerUp);
    mc.addEventListener('mouseleave', function () {
      if (S.isDrawing) onPointerUp(new MouseEvent('mouseup'));
      DOM.brushCursor.style.display = 'none';
    });
    mc.addEventListener('mouseenter', function (e) { updateBrushCursor(e); });

    /* touch events */
    mc.addEventListener('touchstart', onPointerDown, { passive: false });
    mc.addEventListener('touchmove', function (e) { onPointerMove(e); }, { passive: false });
    mc.addEventListener('touchend', onPointerUp, { passive: false });

    /* keyboard shortcuts */
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); }
      if (e.key === 'b' || e.key === 'B') setTool('brush');
      if (e.key === 'r' || e.key === 'R') setTool('rect');
      if (e.key === '[') { S.brushSize = Math.max(3, S.brushSize - 3); DOM.brushSize.value = S.brushSize; DOM.brushSizeVal.textContent = S.brushSize; }
      if (e.key === ']') { S.brushSize = Math.min(80, S.brushSize + 3); DOM.brushSize.value = S.brushSize; DOM.brushSizeVal.textContent = S.brushSize; }
    });

    window.addEventListener('resize', onResize);

    /* drag & drop */
    DOM.canvasArea.addEventListener('dragover', function (e) { e.preventDefault(); e.stopPropagation(); });
    DOM.canvasArea.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) {
        var dt = new DataTransfer();
        dt.items.add(file);
        DOM.fileInput.files = dt.files;
        DOM.fileInput.dispatchEvent(new Event('change'));
      }
    });

    /* load TF.js in background */
    setStatus('正在加载 AI 引擎...', 'working');
    loadTF().then(function () {
      if (S.tfReady) {
        var backend = S.tf.getBackend();
        setStatus('就绪 · AI 引擎已加载 (' + backend + ')', 'ready');
      } else {
        setStatus('就绪 · 使用算法模式 (AI 引擎未加载)', 'ready');
      }
    });

    setStatus('就绪 · 请上传图片', 'ready');
  }

  /* boot */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
