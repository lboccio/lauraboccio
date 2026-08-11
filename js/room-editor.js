// Shared room editor, used by every room page (home, kitchen, bedroom, etc.)
// Loads inventory.json, lets you add items to the room canvas, strips their
// background client-side (unless already pre-cut), and makes them
// draggable/rotatable/resizable/clickable via Fabric.js. Clicking an item
// (without dragging it) opens its `link`, if it has one, in a new tab.
// In edit mode, the sidebar's "On Canvas" list is drag-reorderable — top
// of the list is the front-most layer, bottom is the back-most, and
// dragging an entry there re-orders the matching canvas object.
// Layout is persisted per-room in localStorage for now — there's no
// backend yet, so this doesn't sync across devices.

const ROOM = document.body.dataset.room;
const BASE = document.body.dataset.base ?? "";
const FIXED_WIDTH = Number(document.body.dataset.width) || null;
const FIXED_HEIGHT = Number(document.body.dataset.height) || null;
const BACKGROUND = document.body.dataset.background || null;
const STORAGE_KEY = `room-layout:${ROOM}`;
const EDIT_MODE_KEY = `room-edit-mode:${ROOM}`;
const OVERRIDES_KEY = `item-overrides:${ROOM}`;
const CLICK_DRAG_THRESHOLD = 4; // px of movement below which a mouseup counts as a click, not a drag

const canvas = new fabric.Canvas("room-canvas", { selection: true });
canvas.perPixelTargetFind = true;
canvas.targetFindTolerance = 4;

let itemsById = {};
let inventoryCache = [];
let editMode = localStorage.getItem(EDIT_MODE_KEY) === "1";
let dragSrcId = null;

let history = [];
let historyIndex = -1;
let isRestoring = false;
let initializing = true;

function snapshotState() {
  return canvas.getObjects().map((obj) => ({
    itemId: obj.itemId,
    left: obj.left,
    top: obj.top,
    angle: obj.angle,
    scaleX: obj.scaleX,
    scaleY: obj.scaleY,
  }));
}

function pushHistory() {
  if (isRestoring || initializing) return;
  history = history.slice(0, historyIndex + 1);
  history.push(snapshotState());
  historyIndex = history.length - 1;
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  const undoBtn = document.getElementById("undo-btn");
  const redoBtn = document.getElementById("redo-btn");
  if (undoBtn) undoBtn.disabled = historyIndex <= 0;
  if (redoBtn) redoBtn.disabled = historyIndex >= history.length - 1;
}

async function restoreSnapshot(snapshot) {
  isRestoring = true;
  const snapshotIds = new Set(snapshot.map((s) => s.itemId));

  for (const obj of [...canvas.getObjects()]) {
    if (!snapshotIds.has(obj.itemId)) canvas.remove(obj);
  }

  for (const state of snapshot) {
    let obj = canvas.getObjects().find((o) => o.itemId === state.itemId);
    if (!obj) {
      const item = itemsById[state.itemId];
      if (item) {
        await addItemToRoom(item, state);
        obj = canvas.getObjects().find((o) => o.itemId === state.itemId);
      }
    }
    if (obj) {
      obj.set({
        left: state.left,
        top: state.top,
        angle: state.angle,
        scaleX: state.scaleX,
        scaleY: state.scaleY,
      });
    }
  }

  snapshot.forEach((state, index) => {
    const obj = canvas.getObjects().find((o) => o.itemId === state.itemId);
    if (obj) canvas.moveTo(obj, index);
  });

  canvas.renderAll();
  saveLayout();
  renderSidebar();
  isRestoring = false;
}

function undo() {
  if (historyIndex <= 0) return;
  historyIndex -= 1;
  restoreSnapshot(history[historyIndex]);
  updateUndoRedoButtons();
}

function redo() {
  if (historyIndex >= history.length - 1) return;
  historyIndex += 1;
  restoreSnapshot(history[historyIndex]);
  updateUndoRedoButtons();
}

function resizeCanvas() {
  const wrapper = document.getElementById("canvas-wrapper");
  const w = wrapper.clientWidth;
  const h = wrapper.clientHeight;
  canvas.setWidth(w);
  canvas.setHeight(h);

  if (FIXED_WIDTH && FIXED_HEIGHT) {
    // Scale the fixed-size design to cover the full wrapper (crop overflow,
    // never letterbox), same idea as CSS background-size: cover.
    const scale = Math.max(w / FIXED_WIDTH, h / FIXED_HEIGHT);
    const offsetX = (w - FIXED_WIDTH * scale) / 2;
    const offsetY = (h - FIXED_HEIGHT * scale) / 2;
    canvas.setViewportTransform([scale, 0, 0, scale, offsetX, offsetY]);
  }
  canvas.renderAll();
}
window.addEventListener("resize", resizeCanvas);

function photoUrl(item) {
  return `${BASE}${item.photo}`;
}

async function loadInventory() {
  const res = await fetch(`${BASE}inventory.json`);
  return res.json();
}

function loadBackground() {
  if (!BACKGROUND) return;
  fabric.Image.fromURL(`${BASE}${BACKGROUND}`, (img) => {
    canvas.setBackgroundImage(img, canvas.renderAll.bind(canvas), {
      scaleX: 1,
      scaleY: 1,
      originX: "left",
      originY: "top",
    });
  });
}

function saveLayout() {
  const objects = canvas.getObjects().map((obj) => ({
    itemId: obj.itemId,
    left: obj.left,
    top: obj.top,
    angle: obj.angle,
    scaleX: obj.scaleX,
    scaleY: obj.scaleY,
  }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(objects));
}

function loadLayout() {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : [];
}

function loadOverrides() {
  const raw = localStorage.getItem(OVERRIDES_KEY);
  return raw ? JSON.parse(raw) : {};
}

function saveOverride(itemId, patch) {
  const overrides = loadOverrides();
  overrides[itemId] = { ...(overrides[itemId] || {}), ...patch };
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
}

function applyOverrides(inventory) {
  const overrides = loadOverrides();
  return inventory.map((item) => (overrides[item.id] ? { ...item, ...overrides[item.id] } : item));
}

async function removeBackground(imageUrl) {
  const { removeBackground } = await import(
    "https://esm.sh/@imgly/background-removal@1.5.5"
  );
  const blob = await removeBackground(imageUrl);
  return URL.createObjectURL(blob);
}

async function addItemToRoom(item, placement = {}) {
  const statusEl = document.getElementById(`status-${item.id}`);

  let src = photoUrl(item);
  if (!item.isCutout) {
    if (statusEl) statusEl.textContent = "Removing background…";
    try {
      src = await removeBackground(photoUrl(item));
    } catch (err) {
      console.warn("Background removal failed, using original photo:", err);
    }
  }

  await new Promise((resolve) => {
    fabric.Image.fromURL(
      src,
      (img) => {
        img.set({
          left: placement.left ?? 100,
          top: placement.top ?? 100,
          angle: placement.angle ?? 0,
          scaleX: placement.scaleX ?? 0.3,
          scaleY: placement.scaleY ?? 0.3,
          cornerStyle: "circle",
          transparentCorners: false,
          selectable: editMode,
          hoverCursor: editMode ? "move" : (item.link ? "pointer" : "default"),
        });
        img.itemId = item.id;
        canvas.add(img);
        canvas.renderAll();
        saveLayout();
        resolve();
      },
      { crossOrigin: "anonymous" }
    );
  });
}

function attachLayerDragHandlers(li) {
  li.addEventListener("dragstart", () => {
    dragSrcId = li.dataset.itemId;
    li.classList.add("dragging");
  });
  li.addEventListener("dragend", () => {
    li.classList.remove("dragging");
    dragSrcId = null;
  });
  li.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  li.addEventListener("drop", (e) => {
    e.preventDefault();
    const targetId = li.dataset.itemId;
    if (!dragSrcId || dragSrcId === targetId) return;
    reorderCanvasItems(dragSrcId, targetId);
  });
}

function reorderCanvasItems(srcId, targetId) {
  const list = document.getElementById("canvas-items-list");
  if (!list) return;
  const order = [...list.children].map((li) => li.dataset.itemId); // current front-to-back order
  const fromIdx = order.indexOf(srcId);
  const toIdx = order.indexOf(targetId);
  if (fromIdx === -1 || toIdx === -1) return;
  order.splice(fromIdx, 1);
  order.splice(toIdx, 0, srcId);
  applyZOrder(order);
}

function applyZOrder(frontToBackIds) {
  // The list is displayed front-to-back (top = front); Fabric's object
  // array is back-to-front (index 0 = back-most), so reverse before
  // assigning indexes.
  const backToFrontIds = [...frontToBackIds].reverse();
  backToFrontIds.forEach((id, index) => {
    const obj = canvas.getObjects().find((o) => o.itemId === id);
    if (obj) canvas.moveTo(obj, index);
  });
  canvas.renderAll();
  saveLayout();
  renderSidebar();
  pushHistory();
}

function renderSidebar() {
  const canvasList = document.getElementById("canvas-items-list");
  const availableList = document.getElementById("inventory-list");
  const canvasIds = new Set(canvas.getObjects().map((obj) => obj.itemId));

  if (canvasList) {
    const frontToBack = [...canvas.getObjects()].reverse();
    canvasList.innerHTML = "";
    frontToBack.forEach((obj) => {
      const item = itemsById[obj.itemId];
      if (!item) return;
      const li = document.createElement("li");
      li.className = "layer-item";
      li.draggable = true;
      li.dataset.itemId = item.id;
      li.innerHTML = `
        <img src="${photoUrl(item)}" alt="${item.name}" />
        <span class="item-name">${item.name}</span>
      `;
      attachLayerDragHandlers(li);
      canvasList.appendChild(li);
    });
  }

  if (availableList) {
    const available = inventoryCache.filter(
      (item) => (!item.room || item.room === ROOM) && !canvasIds.has(item.id)
    );
    availableList.innerHTML = "";
    available.forEach((item) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <img src="${photoUrl(item)}" alt="${item.name}" />
        <div class="item-info">
          <div class="item-name">${item.name}</div>
          <div class="item-brand">${item.brand || ""}</div>
          <button data-id="${item.id}">Add to room</button>
          <span id="status-${item.id}" class="status"></span>
        </div>
      `;
      li.querySelector("button").addEventListener("click", async () => {
        await addItemToRoom(item);
        renderSidebar();
        pushHistory();
      });
      availableList.appendChild(li);
    });
  }
}

function showSelectionPanel(obj) {
  const panel = document.getElementById("selection-panel");
  if (!panel) return;
  const item = itemsById[obj.itemId];
  panel.innerHTML = `
    <div class="selection-name">${item ? item.name : "Item"}</div>
    <button id="btn-front">Bring to Front</button>
    <button id="btn-forward">Forward</button>
    <button id="btn-backward">Backward</button>
    <button id="btn-back">Send to Back</button>
    <button id="btn-delete" class="danger">Delete</button>
    <label class="panel-label">Click action (URL)</label>
    <input type="text" id="link-input" placeholder="https://..." value="${item && item.link ? item.link : ""}" />
    <button id="btn-save-link">Save Action</button>
    <span id="link-save-status" class="status"></span>
  `;
  panel.style.display = "block";
  if (item) {
    panel.querySelector("#btn-save-link").onclick = () => {
      const url = panel.querySelector("#link-input").value.trim();
      item.link = url || null;
      saveOverride(item.id, { link: item.link });
      obj.hoverCursor = editMode ? "move" : (item.link ? "pointer" : "default");
      const status = panel.querySelector("#link-save-status");
      if (status) {
        status.textContent = "Saved";
        setTimeout(() => { if (status) status.textContent = ""; }, 1500);
      }
    };
  }
  panel.querySelector("#btn-front").onclick = () => {
    canvas.bringToFront(obj);
    canvas.renderAll();
    saveLayout();
    renderSidebar();
    pushHistory();
  };
  panel.querySelector("#btn-forward").onclick = () => {
    canvas.bringForward(obj);
    canvas.renderAll();
    saveLayout();
    renderSidebar();
    pushHistory();
  };
  panel.querySelector("#btn-backward").onclick = () => {
    canvas.sendBackwards(obj);
    canvas.renderAll();
    saveLayout();
    renderSidebar();
    pushHistory();
  };
  panel.querySelector("#btn-back").onclick = () => {
    canvas.sendToBack(obj);
    canvas.renderAll();
    saveLayout();
    renderSidebar();
    pushHistory();
  };
  panel.querySelector("#btn-delete").onclick = () => {
    canvas.remove(obj);
    canvas.discardActiveObject();
    canvas.renderAll();
    saveLayout();
    hideSelectionPanel();
    renderSidebar();
    pushHistory();
  };
}

function hideSelectionPanel() {
  const panel = document.getElementById("selection-panel");
  if (panel) panel.style.display = "none";
}

function showLinkConfirm(item) {
  const overlay = document.getElementById("link-confirm-overlay");
  if (!overlay) {
    window.open(item.link, "_blank", "noopener");
    return;
  }
  document.getElementById("link-confirm-text").textContent = `Leave this site to visit ${item.name}?`;
  document.getElementById("link-confirm-url").textContent = item.link;
  overlay.style.display = "flex";

  const goBtn = document.getElementById("link-confirm-go");
  const cancelBtn = document.getElementById("link-confirm-cancel");
  goBtn.onclick = () => {
    window.open(item.link, "_blank", "noopener");
    overlay.style.display = "none";
  };
  cancelBtn.onclick = () => {
    overlay.style.display = "none";
  };
}

function applyEditMode() {
  document.body.classList.toggle("edit-mode", editMode);
  canvas.selection = editMode;
  canvas.getObjects().forEach((obj) => {
    obj.selectable = editMode;
    const item = itemsById[obj.itemId];
    obj.hoverCursor = editMode ? "move" : (item && item.link ? "pointer" : "default");
  });
  if (!editMode) {
    canvas.discardActiveObject();
    hideSelectionPanel();
  }
  canvas.renderAll();

  const toggleBtn = document.getElementById("edit-toggle");
  if (toggleBtn) toggleBtn.textContent = editMode ? "Done Editing" : "Edit";

  localStorage.setItem(EDIT_MODE_KEY, editMode ? "1" : "0");
  resizeCanvas(); // sidebar/reset-button visibility changes the wrapper size
}

document.getElementById("edit-toggle")?.addEventListener("click", () => {
  editMode = !editMode;
  applyEditMode();
});

document.getElementById("reset-layout")?.addEventListener("click", () => {
  if (confirm("Reset this room back to its original layout?")) {
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  }
});

document.getElementById("undo-btn")?.addEventListener("click", undo);
document.getElementById("redo-btn")?.addEventListener("click", redo);

canvas.on("object:modified", () => {
  saveLayout();
  pushHistory();
});
canvas.on("selection:created", (e) => showSelectionPanel(e.selected[0]));
canvas.on("selection:updated", (e) => showSelectionPanel(e.selected[0]));
canvas.on("selection:cleared", hideSelectionPanel);

let mouseDownPoint = null;
canvas.on("mouse:down", (opt) => {
  mouseDownPoint = canvas.getPointer(opt.e);
});
canvas.on("mouse:up", (opt) => {
  if (!opt.target || !mouseDownPoint) return;
  const upPoint = canvas.getPointer(opt.e);
  const dist = Math.hypot(upPoint.x - mouseDownPoint.x, upPoint.y - mouseDownPoint.y);
  mouseDownPoint = null;
  if (dist > CLICK_DRAG_THRESHOLD) return; // was a drag, not a click

  const item = itemsById[opt.target.itemId];
  if (item && item.link) {
    showLinkConfirm(item);
  }
});

(async function init() {
  resizeCanvas();
  loadBackground();

  const inventory = applyOverrides(await loadInventory());
  inventoryCache = inventory;
  itemsById = Object.fromEntries(inventory.map((i) => [i.id, i]));

  const savedLayout = loadLayout();
  const savedById = Object.fromEntries(savedLayout.map((p) => [p.itemId, p]));

  const roomItems = inventory.filter((item) => item.room === ROOM);
  for (const item of roomItems) {
    const placement = savedById[item.id] || item.placement || {};
    await addItemToRoom(item, placement);
  }

  renderSidebar();
  applyEditMode();

  initializing = false;
  pushHistory(); // baseline state, so the first real change can be undone back to this
})();
