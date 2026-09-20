/* KTH data dashboard, Google Sheets integration, and 3D markers */
(function () {
"use strict";

var KTH_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQRDp7cWrVS2RXObU8YQ-xhXP31MvYiIiXYVRvUJ-QrraipDG_3AWYb37nDyDtfKJaTbtA1MEXX__zM/pub?output=csv";

var state = { rows: [], filteredRows: [], markers: [], markerGroup: null, selected: null, loadedAt: null };

var ALIASES = {
  id: ["no_registrasi_kth", "no_registrasi", "nomor_registrasi_kth", "registrasi_kth"],
  name: ["nama_kth", "nama kelompok tani hutan", "nama_kelompok_tani_hutan"],
  desa: ["desa", "kelurahan"],
  kecamatan: ["kecamatan"],
  kabupaten: ["kabupaten_kota", "kabupaten", "kabupaten kota", "kabupaten/kota"],
  provinsi: ["provinsi"],
  lat: ["latitude", "lat", "lintang", "y"],
  lon: ["longitude", "lon", "lng", "bujur", "x"],
  members: ["jumlah_anggota", "jumlah anggota", "anggota", "jumlah_member"],
  formed: ["tahun_pembentukan", "tahun pembentukan", "tahun_pembentuk", "tahun_pembentukan_kth"]
};

function norm(v) {
  return String(v == null ? "" : v).trim().toLowerCase()
    .replace(/[\/\\\-]+/g, "_").replace(/\s+/g, "_")
    .replace(/[()]/g, "").replace(/_+/g, "_");
}

function findKey(headers, aliases) {
  var normalized = headers.map(norm);
  for (var i = 0; i < aliases.length; i++) {
    var a = norm(aliases[i]), idx = normalized.indexOf(a);
    if (idx !== -1) return headers[idx];
  }
  for (var j = 0; j < normalized.length; j++) {
    for (var k = 0; k < aliases.length; k++) {
      var aa = norm(aliases[k]);
      if (normalized[j].indexOf(aa) !== -1 || aa.indexOf(normalized[j]) !== -1) return headers[j];
    }
  }
  return null;
}

function schema(rows) {
  var headers = rows.length ? Object.keys(rows[0]) : [], out = {};
  Object.keys(ALIASES).forEach(function (key) { out[key] = findKey(headers, ALIASES[key]); });
  return out;
}

function parseCSV(text) {
  var rows = [], row = [], cell = "", quoted = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else {
      if (c === '"') quoted = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n") {
        row.push(cell.replace(/\r$/, ""));
        if (row.some(function (v) { return String(v).trim() !== ""; })) rows.push(row);
        row = []; cell = "";
      } else cell += c;
    }
  }
  row.push(cell.replace(/\r$/, ""));
  if (row.some(function (v) { return String(v).trim() !== ""; })) rows.push(row);
  if (!rows.length) return [];
  var headers = rows.shift().map(function (h, i) { return String(h || "").trim() || ("Kolom_" + (i + 1)); });
  return rows.map(function (r) {
    var obj = {};
    headers.forEach(function (h, i) { obj[h] = r[i] == null ? "" : String(r[i]).trim(); });
    return obj;
  });
}

function esc(v) {
  return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function num(v) {
  if (v == null || v === "") return 0;
  var s = String(v).replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  var n = parseFloat(s.replace(/[^\d.-]/g, ""));
  return isFinite(n) ? n : 0;
}

function fmt(n) { return new Intl.NumberFormat("id-ID").format(n || 0); }

function unique(rows, key) {
  var set = {};
  rows.forEach(function (r) { var v = String(r[key] || "").trim(); if (v) set[v] = true; });
  return Object.keys(set).sort(function (a, b) { return a.localeCompare(b, "id"); });
}

function text(row, key) { return key && row[key] != null ? String(row[key]).trim() : ""; }

function makeUI() {
  if (document.getElementById("kth-dashboard")) return;
  var dashboard = document.createElement("section");
  dashboard.id = "kth-dashboard";
  dashboard.innerHTML =
    '<div class="kth-title-row"><div><h2 class="kth-title">Dashboard Kelompok Tani Hutan (KTH)</h2>' +
    '<div class="kth-subtitle">Data KTH terhubung langsung dengan Google Sheets</div></div>' +
    '<div id="kth-status" class="kth-status">Memuat data…</div></div>' +
    '<div class="kth-cards">' +
    '<div class="kth-card"><div class="kth-card-label">Total KTH</div><div id="kth-total" class="kth-card-value">–</div></div>' +
    '<div class="kth-card"><div class="kth-card-label">Jumlah Anggota</div><div id="kth-members" class="kth-card-value">–</div></div>' +
    '<div class="kth-card"><div class="kth-card-label">Desa/Kelurahan</div><div id="kth-villages" class="kth-card-value">–</div></div>' +
    '<div class="kth-card"><div class="kth-card-label">Kabupaten/Kota</div><div id="kth-districts" class="kth-card-value">–</div></div></div>' +
    '<div class="kth-filters"><input id="kth-search" type="search" placeholder="Cari nama KTH, registrasi, desa…">' +
    '<select id="kth-kab"><option value="">Semua Kabupaten/Kota</option></select>' +
    '<select id="kth-kec"><option value="">Semua Kecamatan</option></select>' +
    '<select id="kth-select"><option value="">Pilih KTH untuk membuka profil</option></select>' +
    '<button id="kth-reset" type="button">Reset Filter</button></div>';
  var view = document.getElementById("view");
  document.body.insertBefore(dashboard, view);

  var profile = document.createElement("section");
  profile.id = "kth-profile";
  profile.innerHTML = '<div class="kth-profile-empty">Klik titik KTH pada peta untuk menampilkan profil.</div>';
  document.body.appendChild(profile);

  var caption = document.createElement("div");
  caption.id = "kth-map-caption";
  caption.textContent = "Titik KTH: klik marker untuk melihat profil";
  view.appendChild(caption);

  document.getElementById("kth-search").addEventListener("input", applyFilters);
  document.getElementById("kth-kab").addEventListener("change", function () { populateKecamatan(); applyFilters(); });
  document.getElementById("kth-kec").addEventListener("change", applyFilters);
  var kthSelect = document.getElementById("kth-select");
  if (kthSelect) kthSelect.addEventListener("change", openSelectedKTH);
  document.getElementById("kth-reset").addEventListener("click", function () {
    document.getElementById("kth-search").value = "";
    document.getElementById("kth-kab").value = "";
    document.getElementById("kth-kec").value = "";
    var s = document.getElementById("kth-select");
    if (s) s.value = "";
    populateKecamatan(); populateKTHSelect(); applyFilters();
  });
}

function updateDashboard() {
  var s = schema(state.rows), rows = state.filteredRows;
  document.getElementById("kth-total").textContent = fmt(rows.length);
  var members = s.members ? rows.reduce(function (sum, r) { return sum + num(r[s.members]); }, 0) : 0;
  document.getElementById("kth-members").textContent = s.members ? fmt(members) : "–";
  document.getElementById("kth-villages").textContent = s.desa ? fmt(unique(rows, s.desa).length) : "–";
  document.getElementById("kth-districts").textContent = s.kabupaten ? fmt(unique(rows, s.kabupaten).length) : "–";
  var status = document.getElementById("kth-status");
  var when = state.loadedAt ? state.loadedAt.toLocaleTimeString("id-ID", {hour:"2-digit", minute:"2-digit"}) : "";
  status.textContent = rows.length + " KTH ditampilkan" + (when ? " • diperbarui " + when : "");
}

function populateKTHSelect(rows) {
  var s = schema(state.rows), select = document.getElementById("kth-select");
  if (!select) return;
  var base = rows || state.filteredRows || state.rows;
  var vals = base.map(function (r, i) {
    var name = text(r, s.name) || ("KTH " + (i + 1));
    var id = text(r, s.id);
    return {key: id ? id + " | " + name : name, name: name};
  });
  var seen = {};
  vals = vals.filter(function (v) {
    if (seen[v.key]) return false;
    seen[v.key] = true;
    return true;
  }).sort(function(a,b){ return a.name.localeCompare(b.name, "id"); });
  select.innerHTML = '<option value="">Pilih KTH untuk membuka profil</option>' +
    vals.map(function(v){ return '<option value="' + esc(v.key) + '">' + esc(v.name) + '</option>'; }).join("");
}

function openSelectedKTH() {
  var select = document.getElementById("kth-select");
  if (!select || !select.value) return;
  var s = schema(state.rows), key = select.value;
  var row = state.rows.filter(function(r, i) {
    var name = text(r, s.name) || ("KTH " + (i + 1));
    var id = text(r, s.id);
    return (id ? id + " | " + name : name) === key;
  })[0];
  if (row) showProfile(row);
}

function populateKecamatan() {
  var s = schema(state.rows), kab = document.getElementById("kth-kab").value;
  var select = document.getElementById("kth-kec"), current = select.value;
  var base = kab ? state.rows.filter(function (r) { return text(r, s.kabupaten) === kab; }) : state.rows;
  var vals = s.kecamatan ? unique(base, s.kecamatan) : [];
  select.innerHTML = '<option value="">Semua Kecamatan</option>' +
    vals.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join("");
  if (vals.indexOf(current) !== -1) select.value = current;
}

function populateKabupaten() {
  var s = schema(state.rows), select = document.getElementById("kth-kab");
  var vals = s.kabupaten ? unique(state.rows, s.kabupaten) : [];
  select.innerHTML = '<option value="">Semua Kabupaten/Kota</option>' +
    vals.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join("");
  populateKecamatan();
}

function applyFilters() {
  var s = schema(state.rows);
  var search = document.getElementById("kth-search").value.trim().toLowerCase();
  var kab = document.getElementById("kth-kab").value, kec = document.getElementById("kth-kec").value;
  state.filteredRows = state.rows.filter(function (r) {
    if (kab && text(r, s.kabupaten) !== kab) return false;
    if (kec && text(r, s.kecamatan) !== kec) return false;
    if (search && Object.keys(r).map(function (k) { return String(r[k]); }).join(" ").toLowerCase().indexOf(search) === -1) return false;
    return true;
  });
  updateDashboard();
  populateKTHSelect(state.filteredRows);
  rebuildMarkers();
}

function buildMarker(row, s) {
  var lat = num(row[s.lat]), lon = num(row[s.lon]);
  if (!isFinite(lat) || !isFinite(lon) || !lat || !lon) return null;

  // WGS84 latitude/longitude -> Web Mercator (EPSG:3857).
  // IMPORTANT: QGIS2ThreeJS runs this scene in local world coordinates,
  // so always convert map coordinates through the scene's own origin.
  // Scene projection is CEA (+proj=cea +lat_ts=0), not Web Mercator.
  var R = 6378137, rad = Math.PI / 180;
  var mapX = R * lon * rad;
  var mapY = R * Math.sin(lat * rad);

  var world = Q3D.application.scene.toWorldCoordinates({x: mapX, y: mapY, z: 0}, false);

  var group = new THREE.Group();
  group.userData.kth = row;
  group.userData.kthLat = lat;
  group.userData.kthLon = lon;
  group.userData.mapX = mapX;
  group.userData.mapY = mapY;
  group.userData.worldX = world.x;
  group.userData.worldY = world.y;

  // Marker geometry is intentionally built at real-world scale:
  // its center will be placed exactly 10 metres above the terrain.
  var poleMaterial = new THREE.MeshBasicMaterial({color: 0x1f7a45});
  var headMaterial = new THREE.MeshBasicMaterial({color: 0xffd21f});

  var pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.8, 0.8, 10, 12),
    poleMaterial
  );
  pole.position.z = 5;
  group.add(pole);

  var head = new THREE.Mesh(
    new THREE.SphereGeometry(3.5, 20, 20),
    headMaterial
  );
  head.position.z = 10;
  group.add(head);

  return group;
}

function placeOnTerrain(marker) {
  var scene = Q3D.application.scene;
  if (!scene || !scene.sceneLoaded && !Q3D.application.sceneLoaded) return false;

  // Raycast only against currently visible QGIS2ThreeJS layer objects.
  // The scene uses local coordinates, already resolved in buildMarker().
  var objects = (typeof scene.visibleObjects === "function")
    ? scene.visibleObjects(false)
    : [];
  if (!objects.length) return false;

  var bbox = scene.boundingBox(true);
  var zTop = bbox.isEmpty() ? 10000 : bbox.max.z + 1000;

  var ray = new THREE.Raycaster();
  ray.set(
    new THREE.Vector3(marker.userData.worldX, marker.userData.worldY, zTop),
    new THREE.Vector3(0, 0, -1)
  );
  var hits = ray.intersectObjects(objects, true);
  if (!hits.length) return false;

  // First hit is the terrain surface at the KTH coordinate.
  var terrainHit = hits[0];
  if (!terrainHit.point || !isFinite(terrainHit.point.z)) return false;

  // zScale is 1.0 in this TNGGP scene, so one world unit = one metre.
  // The marker pole is 10 m high from the terrain surface.
  marker.position.set(
    marker.userData.worldX,
    marker.userData.worldY,
    terrainHit.point.z
  );
  return true;
}

function hideFlatPlane() {
  var scene = Q3D.application.scene;
  if (!scene) return;
  if (scene.mapLayers) {
    Object.keys(scene.mapLayers).forEach(function (id) {
      var layer = scene.mapLayers[id];
      var name = layer && layer.properties ? String(layer.properties.name || "") : "";
      if (/flat\s*(plane|panel)/i.test(name)) layer.visible = false;
    });
  }
  // Catch exported flat-plane objects even when QGIS2ThreeJS does not expose
  // them through mapLayers. Layer 7 in this scene is the zero-height 2x2 plane.
  var root = scene.scene || scene;
  if (root && root.traverse) {
    root.traverse(function(obj) {
      var n = String(obj.name || "");
      if (/flat\s*(plane|panel)/i.test(n)) obj.visible = false;
      if (obj.userData && String(obj.userData.layerId || obj.userData.layer || "") === "7") obj.visible = false;
    });
  }
}

function rebuildMarkers() {
  if (!Q3D.application.scene || !Q3D.application.sceneLoaded) return;
  hideFlatPlane();
  if (state.markerGroup) Q3D.application.scene.remove(state.markerGroup);
  state.markerGroup = new THREE.Group();
  state.markerGroup.name = "KTH Markers";
  state.markers = [];
  var s = schema(state.rows);
  state.filteredRows.forEach(function (row) {
    var marker = buildMarker(row, s);
    if (!marker) return;
    placeOnTerrain(marker);
    state.markerGroup.add(marker);
    state.markers.push(marker);
  });
  Q3D.application.scene.add(state.markerGroup);
  hideFlatPlane();
  installClickHandler();
  Q3D.application.render();
}

function findKTHHit(e) {
  if (!state.markerGroup || !state.markers.length) return null;
  var canvas = Q3D.application.renderer.domElement, rect = canvas.getBoundingClientRect();
  var x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  var y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  var ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(x, y), Q3D.application.camera);
  var hits = ray.intersectObjects(state.markerGroup.children, true);
  if (!hits.length) return null;
  var o = hits[0].object;
  while (o && !o.userData.kth) o = o.parent;
  return o && o.userData.kth ? o : null;
}

function showProfile(row) {
  state.selected = row;
  var s = schema(state.rows);
  var name = text(row, s.name) || "KTH";
  var loc = [text(row, s.desa), text(row, s.kecamatan), text(row, s.kabupaten), text(row, s.provinsi)].filter(Boolean).join(", ");
  var excluded = {}; [s.lat, s.lon].forEach(function (k) { if (k) excluded[k] = true; });
  var fields = Object.keys(row).filter(function (k) { return !excluded[k] && String(row[k] || "").trim() !== ""; });
  document.getElementById("kth-profile").innerHTML =
    '<div class="kth-profile-head"><div><h2 class="kth-profile-title">' + esc(name) + '</h2>' +
    '<div class="kth-profile-location">' + esc(loc || "Lokasi belum diisi") + '</div></div>' +
    '<div class="kth-status">Klik marker lain untuk mengganti profil</div></div>' +
    '<div class="kth-profile-grid">' +
    fields.map(function (k) { return '<div class="kth-field"><div class="kth-field-label">' + esc(k) +
      '</div><div class="kth-field-value">' + esc(row[k]) + '</div></div>'; }).join("") + '</div>';
  document.getElementById("kth-profile").scrollIntoView({behavior:"smooth", block:"start"});
}

function installClickHandler() {
  if (Q3D.application._kthClickInstalled) return;
  var canvas = Q3D.application.renderer && Q3D.application.renderer.domElement;
  if (!canvas) return;
  canvas.addEventListener("click", function (e) {
    var hit = findKTHHit(e);
    if (hit) showProfile(hit.userData.kth);
  }, false);
  Q3D.application._kthClickInstalled = true;
}

function loadData() {
  makeUI();
  document.getElementById("kth-status").textContent = "Mengambil data Google Sheets…";
  fetch(KTH_CSV_URL, {cache:"no-store"})
    .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.text(); })
    .then(function (csv) {
      var rows = parseCSV(csv);
      if (!rows.length) throw new Error("CSV kosong");
      var s = schema(rows);
      if (!s.lat || !s.lon) throw new Error("Kolom latitude/longitude tidak ditemukan.");
      state.rows = rows; state.loadedAt = new Date();
      populateKabupaten(); applyFilters();
      document.getElementById("kth-map-caption").textContent = "Titik KTH: " + rows.length + " • klik marker untuk melihat profil";
    })
    .catch(function (err) {
      console.error(err);
      document.getElementById("kth-status").textContent = "Gagal memuat data";
      document.getElementById("kth-profile").innerHTML =
        '<div class="kth-error"><strong>Data KTH belum dapat dimuat.</strong><br>' + esc(err.message) +
        '<br><small>Pastikan Google Sheet dipublikasikan ke web dan dapat diakses publik.</small></div>';
    });
}

function initializeWhenReady() {
  makeUI();
  var app = Q3D.application;
  if (app.scene && app.renderer && app.camera) {
    installClickHandler();
    loadData();
    return;
  }
  setTimeout(initializeWhenReady, 300);
}

initializeWhenReady();

setInterval(function () {
  if (document.visibilityState === "visible" && Q3D.application.scene) loadData();
}, 5 * 60 * 1000);

})();
