// Shared room editor, used by every room page (home, kitchen, bedroom, etc.)
// Loads inventory.json, lets you add items to the room canvas, strips their
// background client-side (unless already pre-cut), and makes them
// draggable/rotatable/resizable/clickable via Fabric.js. Clicking an item
// (without dragging it) opens its `link`, if it has one, in a new tab.
// Layout is persisted per-room in localStorage for now — there's no
// backend yet, so this doesn't sync across devices.

const ROOM = document.body.dataset.room;
const BASE = document.body.dataset.base ?? "";
const FIXED_WIDTH = Number(document.body.dataset.width) || null;
const FIXED_HEIGHT = Number(document.body.dataset.height) || null;
const BACKGROUND = document.body.dataset.background || null;
const STORAGE_KEY = `room-layout:${ROOM}`;
const EDIT_MODE_KEY = `room-edit-mode:${ROOM}`;
const CLICK_DRAG_THRESHOLD = 4; // px of movement below which a mouseup counts as a click, not a drag

const canvas = new fabric.Canvas("room-canvas", { selection: true });
canvas.perPixelTargetFind = true;
canvas.targetFindTolerance = 4;

let itemsById = {};
let editMode = localStorage.getItem(EDIT_MODE_KEY) === "1";

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
      if (statusEl) statusEl.textContent = "Added";
    },
    { crossOrigin: "anonymous" }
  );
}

function renderInventorySidebar(items) {
  const list = document.getElementById("inventory-list");
  if (!list) return;
  const available = items.filter((item) => !item.room || item.room === ROOM);
  list.innerHTML = "";
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
    li.querySelector("button").addEventListener("click", () => addItemToRoom(item));
    list.appendChild(li);
  });
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
  `;
  panel.style.display = "block";
  panel.querySelector("#btn-front").onclick = () => {
    canvas.bringToFront(obj);
    canvas.renderAll();
    saveLayout();
  };
  panel.querySelector("#btn-forward").onclick = () => {
    canvas.bringForward(obj);
    canvas.renderAll();
    saveLayout();
  };
  panel.querySelector("#btn-backward").onclick = () => {
    canvas.sendBackwards(obj);
    canvas.renderAll();
    saveLayout();
  };
  panel.querySelector("#btn-back").onclick = () => {
    canvas.sendToBack(obj);
    canvas.renderAll();
    saveLayout();
  };
  panel.querySelector("#btn-delete").onclick = () => {
    canvas.remove(obj);
    canvas.discardActiveObject();
    canvas.renderAll();
    saveLayout();
    hideSelectionPanel();
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

canvas.on("object:modified", saveLayout);
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

  const inventory = await loadInventory();
  itemsById = Object.fromEntries(inventory.map((i) => [i.id, i]));
  renderInventorySidebar(inventory);

  const savedLayout = loadLayout();
  const savedById = Object.fromEntries(savedLayout.map((p) => [p.itemId, p]));

  const roomItems = inventory.filter((item) => item.room === ROOM);
  for (const item of roomItems) {
    const placement = savedById[item.id] || item.placement || {};
    await addItemToRoom(item, placement);
  }

  applyEditMode();
})();
