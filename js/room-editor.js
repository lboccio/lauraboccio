// Shared room editor, used by every room page (home, kitchen, bedroom, etc.)
// Loads inventory.json, lets you add items to the room canvas, strips their
// background client-side (unless already pre-cut), and makes them
// draggable/rotatable/resizable/clickable via Fabric.js. Layout is
// persisted per-room in localStorage for now — there's no backend yet, so
// this doesn't sync across devices.

const ROOM = document.body.dataset.room;
const BASE = document.body.dataset.base ?? "";
const FIXED_WIDTH = Number(document.body.dataset.width) || null;
const FIXED_HEIGHT = Number(document.body.dataset.height) || null;
const BACKGROUND = document.body.dataset.background || null;
const STORAGE_KEY = `room-layout:${ROOM}`;

const canvas = new fabric.Canvas("room-canvas", { selection: true });
canvas.perPixelTargetFind = true;
canvas.targetFindTolerance = 4;

function resizeCanvas() {
  if (FIXED_WIDTH && FIXED_HEIGHT) {
    canvas.setWidth(FIXED_WIDTH);
    canvas.setHeight(FIXED_HEIGHT);
  } else {
    const wrapper = document.getElementById("canvas-wrapper");
    canvas.setWidth(wrapper.clientWidth);
    canvas.setHeight(wrapper.clientHeight);
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
      scaleX: canvas.getWidth() / img.width,
      scaleY: canvas.getHeight() / img.height,
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

canvas.on("object:modified", saveLayout);

(async function init() {
  resizeCanvas();
  loadBackground();

  const inventory = await loadInventory();
  renderInventorySidebar(inventory);

  const savedLayout = loadLayout();
  const savedById = Object.fromEntries(savedLayout.map((p) => [p.itemId, p]));

  const roomItems = inventory.filter((item) => item.room === ROOM);
  for (const item of roomItems) {
    const placement = savedById[item.id] || item.placement || {};
    await addItemToRoom(item, placement);
  }
})();
