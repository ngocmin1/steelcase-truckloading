import React, { useRef, useEffect, useState, useCallback } from 'react';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';

import {
  BOX_CONFIGS,
  TRUCK_DIMENSIONS,
  TRUCK_VOLUME,
  MAX_BOXES,
  DECK_SURFACE_Y,
  STRESS_TEST_TARGET,         // US6 Yash
  HEAVY_BOX_MASS_THRESHOLD,   // US5 Rhea
  DEFAULT_CAMERA_POSITION
} from './constants';
import { STEELCASE_LOAD_EXAMPLES } from './loadExamples';   // US1 Yash
import { initScene } from './TruckScene';
import { useHistory } from './useHistory';
import { GhostPreview } from './GhostPreview';
import { FitSuggestionSystem } from './FitSuggestionSystem';
import { estimateMass, suggestLoadOrder, makeAABB, withinBounds } from './packingScore';
import Header from './Header';
import ControlPanel from './ControlPanel';
import ControlsGuide from './ControlsGuide';
import ShipmentSummary from './ShipmentSummary';             // Becky
import SessionSummaryModal from './SessionSummaryModal';
import SessionCompleteScreen from './SessionCompleteScreen';
import OrientationWidget from './OrientationWidget';
import Icon from './Icons';
import { StabilitySystem } from './StabilitySystem';
import ImportConfirmModal from './ImportConfirmModal';   // US4 Rhea (Sprint 6 carry-over)

// ── US5 Rhea: floating FRAGILE sprite ─────────────────────────────────────
function createFragileLabel(heightFt) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(231,76,60,0.88)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(4, 4, 248, 56, 10);
  else ctx.rect(4, 4, 248, 56);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 26px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('⚠ FRAGILE', 128, 32);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false })
  );
  sprite.scale.set(1.2, 0.3, 1);
  sprite.position.set(0, heightFt / 2 + 0.28, 0);
  return sprite;
}

// ── US7 Rhea: floating restriction sprites ────────────────────────────────
// Same visual language as the FRAGILE label above, in its own color per
// restriction so a box can carry both without the labels being confused.
// Concept borrowed from the reference project's per-carton restrictions
// model (No Stacking / This Side Up), not its code.
function createRestrictionLabel(heightFt, text, bgColor, yOffset = 0) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bgColor;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(4, 4, 248, 56, 10);
  else ctx.rect(4, 4, 248, 56);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 24px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 32);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false })
  );
  sprite.scale.set(1.2, 0.3, 1);
  sprite.position.set(0, heightFt / 2 + 0.28 + yOffset, 0);
  return sprite;
}
const createNoStackLabel   = (heightFt, offset) => createRestrictionLabel(heightFt, '🔒 NO STACK', 'rgba(230,126,34,0.9)', offset);
const createThisSideUpLabel = (heightFt, offset) => createRestrictionLabel(heightFt, '⬆ THIS SIDE UP', 'rgba(41,128,185,0.9)', offset);

const TruckLoadingPrototype = () => {
  // ── Refs ───────────────────────────────────────────────────────────────────
  const mountRef           = useRef(null);
  const sceneRef           = useRef(null);
  const cameraRef          = useRef(null);
  const rendererRef        = useRef(null);
  const dragControllerRef  = useRef(null);
  const cargoRegistryRef   = useRef([]);
  const saveToHistoryRef   = useRef(null);
  const physicsEnabledRef  = useRef(true);
  const physicsApiRef      = useRef(null);
  const ghostPreviewRef    = useRef(null);
  const stabilitySystemRef = useRef(null);
  const fitSuggestionRef   = useRef(null);   // US1/US2 Yash: AI Best Fit engine
  const suggestionTargetRef = useRef(null);  // the carton the ghost is describing
  const initialLoadSnapshotRef = useRef(null);
  // US4 Rhea: stable ref to the latest checkFragileStacking so the scene-init
  // effect (which only re-runs when checkStabilityAfterMove changes) can call
  // an up-to-date version from its afterPositionChanged callback without
  // needing to tear down and rebuild the THREE scene every time
  // availableBoxes changes.
  const checkFragileStackingRef = useRef(null);
  // US6 Yash: geometry/material caches
  const geometryCacheRef   = useRef(new Map());
  const edgeCacheRef       = useRef(new Map());
  const materialCacheRef   = useRef(new Map());
  const lineMaterialRef    = useRef(new THREE.LineBasicMaterial({ color: 0x000000 }));
  const fragilePinkLineRef = useRef(new THREE.LineBasicMaterial({ color: 0xff0066 })); // US5
  const statsRef           = useRef({ fps: 60, boxCount: 0 });

  // ── State ──────────────────────────────────────────────────────────────────
  const [boxes, setBoxes]                             = useState([]);
  const [availableBoxes, setAvailableBoxes]           = useState(BOX_CONFIGS);
  const [selectedBoxType, setSelectedBoxType]         = useState(BOX_CONFIGS[0]);
  const [stats, setStats]                             = useState({ fps: 60, boxCount: 0 });
  const [isLoading, setIsLoading]                     = useState(true);
  const [isBoxDragging, setIsBoxDragging]             = useState(false);
  const [suggestion, setSuggestion]                   = useState(null);
  const [suggestionCandidates, setSuggestionCandidates] = useState([]);
  const [isCalcSuggestion, setIsCalcSuggestion]       = useState(false);
  const [searchDiagnostics, setSearchDiagnostics]     = useState(null);
  const [layoutVersion, setLayoutVersion]             = useState(0);
  // US1 Yash: load examples + queue
  const [boxQueue, setBoxQueue]                       = useState([]);
  const [selectedExampleName, setSelectedExampleName] = useState('Manual');
  const [selectedExampleId, setSelectedExampleId]     = useState(null);
  const [queueSummary, setQueueSummary]               = useState([]);
  // US6 Yash: stress test
  const [stressResult, setStressResult]               = useState(null);
  const [isStressTestRunning, setIsStressTestRunning] = useState(false);
  const [isAutofilling, setIsAutofilling]             = useState(false);
  // Becky: stop filter (ShipmentSummary)
  const [activeStopFilter, setActiveStopFilter]       = useState(null);
  const [showSessionSummary, setShowSessionSummary]   = useState(false);
  const [sessionSummaryMetrics, setSessionSummaryMetrics] = useState(null);
  // US5 Rhea: fragile warning toast
  const [fragileWarning, setFragileWarning]           = useState(null);
  const [orientEntry, setOrientEntry]                 = useState(null);
  const [orientWidgetPos, setOrientWidgetPos]         = useState({ x: 0, y: 0 });
  const [openStagePanel, setOpenStagePanel]           = useState(null); // 'controls' | 'shipment' | null
  const [stabilityWarning, setStabilityWarning]       = useState(null);
  const [selectedGroupIds, setSelectedGroupIds]       = useState([]);
  const [showSessionComplete, setShowSessionComplete] = useState(false);

  // US4 Rhea (Sprint 6 carry-over): Import Confirmation Preview.
  // Holds the PARSED-BUT-NOT-YET-APPLIED load plan plus the summary shown in
  // the modal. Nothing in the scene/registry changes until the user confirms
  // (see applyImportedLoadPlan) — cancelling just clears this back to null.
  const [importPreview, setImportPreview] = useState(null);

  // ── History ────────────────────────────────────────────────────────────────
  const { history, historyIndex, saveToHistory, undo, redo, clearHistory } =
    useHistory(cargoRegistryRef, rendererRef, sceneRef, cameraRef);
  saveToHistoryRef.current = saveToHistory;

  // ── Space utilization ──────────────────────────────────────────────────────
  // Read straight off the live cargo registry instead of re-deriving each
  // box's volume from a config lookup by id (which silently dropped a box's
  // contribution — and understated utilization — whenever its type was not
  // found in `availableBoxes`/`BOX_CONFIGS`, e.g. after switching load
  // examples or importing a plan). `entry.dimensions` is each box's own
  // static width/height/depth, so its product is correct regardless of which
  // orientation the box currently sits in (rotating a box changes which axis
  // points where, not its volume).
  //
  // The in/out check now also tests the box's actual world-aligned footprint
  // (`entry.size`, which DOES reflect the current rotation) against all three
  // truck axes — the old check only looked at X/Z, so a box resting above the
  // trailer's roof height (or, in principle, below the floor) still counted
  // toward the "used" volume even though it could not legally be delivered.
  const usedVolume = cargoRegistryRef.current.reduce((total, entry) => {
    const pos = entry.mesh.position;
    const half = { x: entry.size.x / 2, y: entry.size.y / 2, z: entry.size.z / 2 };
    const eps = 1e-3;
    const isInsideTruck =
      pos.x - half.x > -TRUCK_DIMENSIONS.length / 2 - eps && pos.x + half.x < TRUCK_DIMENSIONS.length / 2 + eps &&
      pos.z - half.z > -TRUCK_DIMENSIONS.width  / 2 - eps && pos.z + half.z < TRUCK_DIMENSIONS.width  / 2 + eps &&
      pos.y - half.y > -eps && pos.y + half.y < TRUCK_DIMENSIONS.height + eps;
    if (!isInsideTruck) return total;
    const d = entry.dimensions;
    return total + d.width * d.height * d.depth;
  }, 0);

  const volumePercentage = ((usedVolume / TRUCK_VOLUME) * 100).toFixed(2);

  useEffect(() => { statsRef.current = stats; }, [stats]);

  // ── US5 Rhea: auto-dismiss fragile warning after 4 s ─────────────────────
  useEffect(() => {
    if (!fragileWarning) return;
    const t = setTimeout(() => setFragileWarning(null), 4000);
    return () => clearTimeout(t);
  }, [fragileWarning]);

  useEffect(() => {
    if (!stabilityWarning || stabilityWarning.status === 'blocked') return;
    const t = setTimeout(() => setStabilityWarning(null), 5000);
    return () => clearTimeout(t);
  }, [stabilityWarning]);

  // ── Becky: update selectedBoxType when stop filter changes ────────────────
  const filteredBoxes = activeStopFilter
    ? availableBoxes.filter(box => box.stop === activeStopFilter && !box.isZeroDim)
    : availableBoxes;

  useEffect(() => {
    if (activeStopFilter) {
      const boxesForStop = availableBoxes.filter(box => box.stop === activeStopFilter && !box.isZeroDim);
      if (boxesForStop.length > 0) setSelectedBoxType(boxesForStop[0]);
      else setSelectedBoxType(null);
    }
    // When filter cleared, restore first available box
    else if (availableBoxes.length > 0) {
      setSelectedBoxType(availableBoxes[0]);
    }
  }, [activeStopFilter, availableBoxes]);

  // ── US6 Yash: geometry / material caches ──────────────────────────────────
  const getDimensionKey = (d) => `${d.width.toFixed(3)}-${d.height.toFixed(3)}-${d.depth.toFixed(3)}`;

  const getSharedGeometry = (dimensions) => {
    const key = getDimensionKey(dimensions);
    if (!geometryCacheRef.current.has(key))
      geometryCacheRef.current.set(key, new THREE.BoxGeometry(dimensions.width, dimensions.height, dimensions.depth));
    return geometryCacheRef.current.get(key);
  };

  const getSharedEdges = (dimensions) => {
    const key = getDimensionKey(dimensions);
    if (!edgeCacheRef.current.has(key))
      edgeCacheRef.current.set(key, new THREE.EdgesGeometry(getSharedGeometry(dimensions)));
    return edgeCacheRef.current.get(key);
  };

  // US5: fragile boxes get pink material, cached separately
  const getSharedMaterial = (boxType) => {
    const isFragile = boxType.fragile ?? false;
    const key = isFragile ? `fragile-${boxType.color}` : `${boxType.color}`;
    if (!materialCacheRef.current.has(key)) {
      materialCacheRef.current.set(key, new THREE.MeshStandardMaterial({
        color:     isFragile ? 0xff69b4 : boxType.color,
        roughness: 0.5,
        metalness: 0.1,
        ...(isFragile && { emissive: new THREE.Color(0xff0066), emissiveIntensity: 0.08 })
      }));
    }
    return materialCacheRef.current.get(key);
  };

  const disposeSharedResources = () => {
    geometryCacheRef.current.forEach(g => g.dispose());
    edgeCacheRef.current.forEach(g => g.dispose());
    materialCacheRef.current.forEach(m => m.dispose());
    lineMaterialRef.current?.dispose();
    fragilePinkLineRef.current?.dispose();
  };

  // ── US1 Yash: load-example helpers ────────────────────────────────────────
  const mapSteelcaseBoxToRuntimeType = (exampleId, boxDef, index) => {
    const dimensions = {
      width:  boxDef.dimensionsInches.width  / 12,
      height: boxDef.dimensionsInches.height / 12,
      depth:  boxDef.dimensionsInches.depth  / 12
    };
    return {
      id:    `${exampleId}-${boxDef.typeId}-${index}`,
      label: boxDef.label,
      color: boxDef.color,
      dimensions,
      // Estimate from volume when the dataset carries no weight — a flat 20 lb
      // for every carton made the weight-aware ranking meaningless.
      physics: {
        mass: boxDef.mass ?? estimateMass({
          x: dimensions.width, y: dimensions.height, z: dimensions.depth
        }),
        friction: 0.9,
        restitution: 0.0
      },
      fragile: boxDef.fragile ?? false,  // US5
      restrictions: boxDef.restrictions ?? {}  // US7: noStack / thisSideUp
    };
  };

  const buildQueueFromExample = useCallback((example) => {
    const queue = [];
    example.boxes.forEach((boxDef, index) => {
      const rt = mapSteelcaseBoxToRuntimeType(example.id, boxDef, index);
      for (let i = 0; i < boxDef.quantity; i++) queue.push(rt);
    });
    return queue;
  }, []);

  const buildQueueSummary = useCallback((queue) => {
    const grouped = new Map();
    queue.forEach(item => {
      if (!grouped.has(item.id)) grouped.set(item.id, { label: item.label, color: item.color, count: 0 });
      grouped.get(item.id).count += 1;
    });
    return Array.from(grouped.values());
  }, []);

  const checkStabilityAfterMove = useCallback((entry) => {
    if (!stabilitySystemRef.current) return;
    const result = stabilitySystemRef.current.evaluate(
      entry.mesh.position,
      entry.size,
      entry.mesh
    );
    if (result.status === 'ok') {
      setStabilityWarning(null);
    } else {
      setStabilityWarning({ message: result.message, status: result.status });
    }
  }, []);

  const checkStabilityOnPlace = useCallback((pos, size) => {
    if (!stabilitySystemRef.current) return true;
    const result = stabilitySystemRef.current.evaluate(pos, size);
    if (result.status === 'blocked') {
      setStabilityWarning({ message: result.message, status: 'blocked' });
      return false;
    }
    if (result.status === 'warn') {
      setStabilityWarning({ message: result.message, status: 'warn' });
    } else {
      setStabilityWarning(null);
    }
    return true;
  }, []);

  // ── Scene init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mountRef.current) return;
    const { scene, camera, renderer, dragController, cleanup } = initScene({
      mountEl: mountRef.current,
      cargoRegistry: cargoRegistryRef.current,
      physicsEnabledRef,
      physicsApiRef,
      setStats,
      setIsLoading,
      setIsBoxDragging,
      saveToHistoryRef,
      onLayoutChanged: () => setLayoutVersion(prev => prev + 1),
      onOrientPick: (entry, cx, cy) => {
        setOrientEntry(entry);
        setOrientWidgetPos({ x: cx, y: cy });
      },
      onGroupChanged: (ids) => setSelectedGroupIds([...ids]),
      afterPositionChanged: (mesh) => {
        const entry = cargoRegistryRef.current.find(e => e.mesh === mesh);
        if (!entry) return;
        checkStabilityAfterMove(entry);
        // US4 Rhea (Task 3): the fragile-stacking warning previously only
        // fired on spawn and on AI "Snap to Suggestion" — a box manually
        // dragged into a stacking position never re-checked. TruckScene now
        // forwards afterPositionChanged from DragController's onPositionChanged,
        // so this fires for manual drag placements too.
        checkFragileStackingRef.current?.(entry);
      },
    });
    sceneRef.current           = scene;
    cameraRef.current          = camera;
    rendererRef.current        = renderer;
    dragControllerRef.current  = dragController;
    ghostPreviewRef.current    = new GhostPreview(scene);
    stabilitySystemRef.current = new StabilitySystem(cargoRegistryRef.current);
    fitSuggestionRef.current   = new FitSuggestionSystem(cargoRegistryRef.current);

    return () => {
      ghostPreviewRef.current?.hide();
      stabilitySystemRef.current = null;
      fitSuggestionRef.current   = null;
      cleanup();
      disposeSharedResources();
    };
  }, [checkStabilityAfterMove]);

  // US1: auto-select first load example on mount
  useEffect(() => {
    if (STEELCASE_LOAD_EXAMPLES.length > 0 && !selectedExampleId)
      handleLoadExampleSelect(STEELCASE_LOAD_EXAMPLES[0].id);
  }, []);

  const refreshPlacementSuggestions = useCallback((showNoFitAlert = false) => {
    if (!ghostPreviewRef.current || !fitSuggestionRef.current) return;

    // The ghost must describe the carton "Snap Last Box" will actually move —
    // otherwise we were ranking spots for the NEXT queued SKU and then snapping
    // a different box into them (and overwriting its collision size to match).
    // The target is also excluded from the obstacle set: with it left in, every
    // suggestion had to dodge the box's own spawn position, which is what
    // scattered cartons down the trailer instead of packing them together.
    const target = cargoRegistryRef.current[cargoRegistryRef.current.length - 1] ?? null;
    const source = target ?? selectedBoxType;

    if (!source) {
      ghostPreviewRef.current.hide();
      setSuggestionCandidates([]);
      setSuggestion(null);
      setSearchDiagnostics(null);
      suggestionTargetRef.current = null;
      return;
    }

    const dims = target ? target.dimensions : selectedBoxType.dimensions;
    const size = { x: dims.width, y: dims.height, z: dims.depth };
    const ghostColor = target
      ? (target.baseMaterial?.color
          ? `#${target.baseMaterial.color.getHexString()}`
          : '#00ff88')
      : selectedBoxType.color;

    // US2: the engine scores every orientation of the carton, so `size` here is
    // the UNROTATED SKU and the winning pose comes back in the result.
    const exclude = target ? [target] : [];
    const candidates = fitSuggestionRef.current.findBestFits(size, 3, {
      mass: source.physics?.mass ?? estimateMass(size),
      fragile: source.fragile ?? false,
      restrictions: source.restrictions ?? {},   // US7: noStack / thisSideUp
      exclude
    });
    setSearchDiagnostics(fitSuggestionRef.current.lastSearch);

    setSuggestionCandidates(candidates);
    const best = candidates[0] ?? null;
    // Remember what the ghost is describing: snapping must move THAT carton
    // into THAT pose, not re-solve and land somewhere the loader never saw.
    suggestionTargetRef.current = best ? target : null;
    setSuggestion(best);

    if (best) {
      // US2: the ghost renders in the winning orientation, which is not
      // necessarily the one the carton is currently sitting in. It is built
      // from the carton's own dimensions and then turned, exactly like the real
      // mesh — `best.size` is the world-aligned extent of that pose, and using
      // it here would rotate the preview a second time.
      ghostPreviewRef.current.show(
        best.position,
        size,
        ghostColor,
        best.quaternion
      );
    } else {
      ghostPreviewRef.current.hide();
      if (showNoFitAlert) alert('No valid placement found — the truck may be full!');
    }
  }, [selectedBoxType]);

  useEffect(() => {
    refreshPlacementSuggestions(false);
  }, [selectedBoxType, layoutVersion, refreshPlacementSuggestions]);

  // ── Camera View ────────────────────────────────────────────────────────────
  const handleCameraView = (view) => {
    if (!cameraRef.current) return;
    const c = cameraRef.current;
    if      (view === 'top')  c.position.set(0, 80, 0.1);
    else if (view === 'side') c.position.set(0, 5, 60);
    else if (view === 'back') c.position.set(-60, 8, 0);
    else                      c.position.set(DEFAULT_CAMERA_POSITION.x, DEFAULT_CAMERA_POSITION.y, DEFAULT_CAMERA_POSITION.z);
  };

  // ── Create Physics Body ────────────────────────────────────────────────────
  const createBoxBody = (boxType, boxMesh) => {
    const physicsApi = physicsApiRef.current;
    if (!physicsApi?.world) return null;
    const { width, height, depth } = boxType.dimensions;
    const bodyMaterial = new CANNON.Material(`box-${boxType.id}-${Date.now()}`);
    const friction     = boxType.physics?.friction    ?? 0.9;
    const restitution  = boxType.physics?.restitution ?? 0.0;
    if (physicsApi.materials?.defaultMaterial)
      physicsApi.world.addContactMaterial(new CANNON.ContactMaterial(bodyMaterial, physicsApi.materials.defaultMaterial, { friction, restitution }));
    if (physicsApi.materials?.wallMaterial)
      physicsApi.world.addContactMaterial(new CANNON.ContactMaterial(bodyMaterial, physicsApi.materials.wallMaterial, { friction: Math.max(friction, 0.95), restitution }));
    const body = new CANNON.Body({
      mass: boxType.physics?.mass ?? 20, material: bodyMaterial,
      shape: new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, depth / 2)),
      position: new CANNON.Vec3(boxMesh.position.x, boxMesh.position.y, boxMesh.position.z),
      angularDamping: 0.98, linearDamping: 0.55,
      allowSleep: true, sleepSpeedLimit: 0.08, sleepTimeLimit: 0.5
    });
    body.quaternion.set(boxMesh.quaternion.x, boxMesh.quaternion.y, boxMesh.quaternion.z, boxMesh.quaternion.w);
    body.fixedRotation = false;
    body.updateMassProperties();
    // Middle ground: allow tilt/roll without wild spinning (was 1,1,1).
    body.angularFactor.set(0.45, 1, 0.45);
    body.angularVelocity.set(0, 0, 0);
    body.velocity.set(0, 0, 0);
    physicsApi.world.addBody(body);
    return body;
  };

  // ── Becky: enhanced CSV upload with stop/dimString/isZeroDim/availableQty ─
  const handleCSVUpload = (event) => {
    event?.preventDefault();
    const file = event.dataTransfer ? event.dataTransfer.files[0] : event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const lines = text.split(/\r?\n|\r/).map(l => l.trim()).filter(l => l);
      if (lines.length < 2) { alert('This CSV file is empty!'); return; }
      const headers = lines[0].split(',').map(h => h.trim());
      const lenIdx  = headers.indexOf('Length');
      const widIdx  = headers.indexOf('Width');
      const hgtIdx  = headers.indexOf('Height');
      const qtyIdx  = headers.indexOf('# Pieces');
      const stopIdx = headers.indexOf('Stop');
      if (lenIdx === -1 || widIdx === -1 || hgtIdx === -1) {
        alert('Error: CSV missing Length, Width, or Height columns.'); return;
      }
      const parsedGroups = {};
      const colors = ['#FF6B35', '#004E89', '#1AA37A', '#9B59B6', '#E74C3C', '#F39C12', '#2C3E50'];
      for (let i = 1; i < lines.length; i++) {
        try {
          const cols     = lines[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
          if (cols.length < Math.max(lenIdx, widIdx, hgtIdx)) continue;
          const l        = parseFloat(cols[lenIdx]) || 0;
          const w        = parseFloat(cols[widIdx])  || 0;
          const h        = parseFloat(cols[hgtIdx])  || 0;
          const isZeroDim = l === 0 && w === 0 && h === 0;
          const wgtIdx   = headers.indexOf('Weight');
          const qty      = qtyIdx  !== -1 ? parseInt(cols[qtyIdx])  || 1 : 1;
          const rowWeight = wgtIdx !== -1 ? parseFloat(cols[wgtIdx]) || 0 : 0;
          const stopVal  = stopIdx !== -1 && cols[stopIdx] ? cols[stopIdx].replace(/"/g, '').trim() : 'Unassigned';
          const dimString = isZeroDim ? `0″ × 0″ × 0″` : `${l}″ × ${w}″ × ${h}″`;
          const groupKey  = `${stopVal}_${dimString}`;
          if (!parsedGroups[groupKey]) {
            parsedGroups[groupKey] = {
              id:           `csv_${groupKey.replace(/[^a-zA-Z0-9]/g, '_')}`,
              dimensions:   { width: l / 12, height: h / 12, depth: w / 12 },
              color:        isZeroDim ? '#ced4da' : colors[Object.keys(parsedGroups).length % colors.length],
              label:        `Package: ${dimString}`,
              dimString,
              isZeroDim,
              availableQty: 0,
              stop:         stopVal,
              // Use the CSV's Weight column when present, else estimate from
              // volume. A flat 20 lb made weight-aware ranking meaningless.
              physics: {
                mass: rowWeight > 0
                  ? rowWeight
                  : estimateMass({ x: l / 12, y: h / 12, z: w / 12 }),
                friction: 0.9,
                restitution: 0.0
              },
              fragile:      false
            };
          }
          parsedGroups[groupKey].availableQty += qty;
        } catch (err) { console.warn(`Skipped row ${i}:`, lines[i]); }
      }
      const parsedBoxes = Object.values(parsedGroups);
      if (parsedBoxes.length > 0) {
        setSelectedExampleName('Manual CSV');
        setSelectedExampleId(null);
        setBoxQueue([]);
        setQueueSummary([]);
        setAvailableBoxes(parsedBoxes);
        setSelectedBoxType(null);
        setActiveStopFilter(null);
      } else { alert('No valid box dimensions found in this CSV.'); }
    };
    reader.readAsText(file);
    if (event.target?.value) event.target.value = null;
  };

  // ── US5 Rhea: check if a newly-placed heavy box sits on a fragile one ─────
  const checkFragileStacking = useCallback((newEntry) => {
    const isHeavy = (newEntry.physics?.mass ?? 0) >= HEAVY_BOX_MASS_THRESHOLD;
    if (!isHeavy) return;
    const newBottom = newEntry.mesh.position.y - newEntry.size.y / 2;
    const eps = 0.15;
    for (const other of cargoRegistryRef.current) {
      if (other === newEntry || !(other.fragile ?? false)) continue;
      const otherTop = other.mesh.position.y + other.size.y / 2;
      if (Math.abs(newBottom - otherTop) > eps) continue;
      const dx = Math.abs(newEntry.mesh.position.x - other.mesh.position.x);
      const dz = Math.abs(newEntry.mesh.position.z - other.mesh.position.z);
      if (dx < (newEntry.size.x / 2 + other.size.x / 2) - 0.05 &&
          dz < (newEntry.size.z / 2 + other.size.z / 2) - 0.05) {
        const cfg = availableBoxes.find(c => c.id === other.type) || BOX_CONFIGS.find(c => c.id === other.type);
        setFragileWarning(`⚠️ Heavy box (${newEntry.physics.mass} lbs) placed on FRAGILE box "${cfg?.label ?? other.label}"! Move it to avoid damage.`);
        return;
      }
    }
  }, [availableBoxes]);

  // US4 Rhea (Task 3): keep a stable ref to the latest checkFragileStacking so
  // the scene-init effect's afterPositionChanged callback (created once, and
  // only recreated when checkStabilityAfterMove changes) always calls the
  // current version — without needing to add checkFragileStacking to that
  // effect's dependency array, which would tear down and rebuild the entire
  // THREE/cannon scene every time availableBoxes changes.
  useEffect(() => {
    checkFragileStackingRef.current = checkFragileStacking;
  }, [checkFragileStacking]);

  // ── US6 Yash + US5 Rhea: core box spawner ─────────────────────────────────
  const addBoxFromType = useCallback((boxType) => {
    if (!sceneRef.current || !boxType) return false;
    if (cargoRegistryRef.current.length >= MAX_BOXES) {
      alert(`Maximum ${MAX_BOXES} boxes reached`); return false;
    }
    const isFragile      = boxType.fragile ?? false;
    const restrictions   = boxType.restrictions ?? {};   // US7
    const isNoStack      = restrictions.noStack ?? false;
    const isThisSideUp   = restrictions.thisSideUp ?? false;
    const boxGeometry    = getSharedGeometry(boxType.dimensions);
    const boxMaterial    = getSharedMaterial(boxType);
    const box            = new THREE.Mesh(boxGeometry, boxMaterial);
    const currentCount   = cargoRegistryRef.current.length;

    // Wide-grid spawn (US6)
    const halfLen = TRUCK_DIMENSIONS.length / 2;
    const halfW   = TRUCK_DIMENSIONS.width  / 2;
    const marginX = 3.2, marginZ = 0.85;
    const usableX = TRUCK_DIMENSIONS.length - marginX * 2;
    const usableZ = TRUCK_DIMENSIONS.width  - marginZ * 2;
    const COLS_X  = 9, ROWS_Z = 3;
    const layer   = Math.floor(currentCount / (COLS_X * ROWS_Z));
    const slotIdx = currentCount % (COLS_X * ROWS_Z);
    const col     = slotIdx % COLS_X;
    const row     = Math.floor(slotIdx / COLS_X);
    const spawnX  = -halfLen + marginX + (col + 0.5) * (usableX / COLS_X) + layer * 0.35;
    const spawnZ  = -halfW   + marginZ + (row + 0.5) * (usableZ / ROWS_Z);

    // Lay long-thin parcels flat
    const isLongAndThin = boxType.dimensions.height > 2.5 && Math.min(boxType.dimensions.width, boxType.dimensions.depth) < 1.0;
    if (isLongAndThin) box.quaternion.setFromEuler(new THREE.Euler(0, 0, Math.PI / 2));

    // entry.size must be the WORLD-axis-aligned extent (see CollisionSystem /
    // DragController). Turning the parcel 90° about Z swaps its width and
    // height in world space; storing the unrotated dimensions here gave every
    // 48" parcel the wrong collision bounds.
    const worldSize = isLongAndThin
      ? { x: boxType.dimensions.height, y: boxType.dimensions.width, z: boxType.dimensions.depth }
      : { x: boxType.dimensions.width, y: boxType.dimensions.height, z: boxType.dimensions.depth };

    box.position.set(spawnX, 8, spawnZ);
    box.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(box);
    box.position.y += 0.22 - bbox.min.y;
    if (layer > 0) box.position.y += layer * 1.15;
    box.updateMatrixWorld(true);

    // The spawn grid is fixed and was not collision-checked. Once cargo has
    // been packed together (by AI Best Fit, or by hand) a later slot can land
    // *inside* an already-placed carton; the solver then ejects both, which
    // showed up as interpenetrating and toppled boxes. Rest the new carton on
    // top of whatever already occupies its column instead.
    const spawnBox = new THREE.Box3().setFromObject(box);
    let columnTop = DECK_SURFACE_Y;
    for (const other of cargoRegistryRef.current) {
      const o = makeAABB(other.mesh.position, other.size);
      if (spawnBox.min.x < o.max.x && spawnBox.max.x > o.min.x &&
          spawnBox.min.z < o.max.z && spawnBox.max.z > o.min.z) {
        columnTop = Math.max(columnTop, o.max.y);
      }
    }
    const clearance = columnTop + 0.02 - spawnBox.min.y;
    if (clearance > 0) {
      box.position.y += clearance;
      box.updateMatrixWorld(true);
    }

    box.castShadow    = currentCount < 30; // US6: skip distant shadow casters
    box.receiveShadow = true;

    // US5: pink edge lines for fragile boxes
    box.add(new THREE.LineSegments(
      getSharedEdges(boxType.dimensions),
      isFragile ? fragilePinkLineRef.current : lineMaterialRef.current
    ));
    // US5: floating FRAGILE sprite
    if (isFragile) box.add(createFragileLabel(boxType.dimensions.height));
    // US7: floating restriction sprites — stack them if a carton carries both
    if (isNoStack) box.add(createNoStackLabel(boxType.dimensions.height, isFragile ? 0.34 : 0));
    if (isThisSideUp) box.add(createThisSideUpLabel(boxType.dimensions.height, (isFragile ? 0.34 : 0) + (isNoStack ? 0.34 : 0)));

    sceneRef.current.add(box);
    const body = createBoxBody(boxType, box);

    const entry = {
      id:           `${boxType.id}-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      type:         boxType.id,
      label:        boxType.label,
      mesh:         box,
      body,
      size:         { ...worldSize },
      dimensions:   { ...boxType.dimensions },
      physics:      { ...boxType.physics },
      fragile:      isFragile,   // US5
      restrictions: { ...restrictions },  // US7
      baseMaterial: boxMaterial
    };

    cargoRegistryRef.current.push(entry);
    setBoxes(prev => [...prev, { id: entry.id, mesh: box, type: boxType.id }]);
    setStats(prev => ({ ...prev, boxCount: prev.boxCount + 1 }));
    setLayoutVersion(prev => prev + 1);
    ghostPreviewRef.current?.hide();
    setSuggestion(null);
    suggestionTargetRef.current = null;

    // US5: check stacking after state settles
    setTimeout(() => checkFragileStacking(entry), 100);
    return entry;
  }, [checkFragileStacking]);

  // Move a carton into a solved pose: position, the winning rotation, its
  // world-aligned size, and the physics body to match.
  const applyPlacement = useCallback((entry, target) => {
    entry.mesh.position.copy(target.position);
    // US2 task 3: apply the winning rotation to the real mesh, so the carton
    // ends up in the orientation the preview promised.
    if (target.quaternion) entry.mesh.quaternion.copy(target.quaternion);
    entry.size.x = target.size.x; entry.size.y = target.size.y; entry.size.z = target.size.z;
    if (entry.body) {
      entry.body.position.set(target.position.x, target.position.y, target.position.z);
      entry.body.quaternion.set(
        entry.mesh.quaternion.x,
        entry.mesh.quaternion.y,
        entry.mesh.quaternion.z,
        entry.mesh.quaternion.w
      );
      entry.body.velocity.set(0, 0, 0);
      entry.body.angularVelocity.set(0, 0, 0);
      // Put it to sleep rather than waking it: the placement is already a
      // resting, collision-free pose, so handing it to the solver awake just
      // let it be nudged off the stack and settle somewhere slightly wrong.
      // Contact from a dragged carton still wakes it normally.
      entry.body.sleep();
    }
  }, []);

  // Add a carton straight into the AI Best Fit spot instead of the spawn grid.
  // If nothing fits (or the spot fails the stability check) it stays where it
  // spawned, and the ghost/Snap flow still works as before.
  const addBoxAtBestFit = useCallback((boxType) => {
    const entry = addBoxFromType(boxType);
    if (!entry || !fitSuggestionRef.current) return entry;

    const dims = entry.dimensions;
    const target = fitSuggestionRef.current.findBestFit(
      { x: dims.width, y: dims.height, z: dims.depth },
      {
        mass: entry.physics?.mass ?? estimateMass(entry.size),
        fragile: entry.fragile ?? false,
        // US7: this was missing here, so a box added straight into its Best
        // Fit spot (every "Add box" / queued box, and now Autofill) could get
        // rested under another carton or flipped onto its side even when it
        // carried a No-Stack / This-Side-Up restriction — those rules only
        // ever reached the search via the Suggest/Snap buttons.
        restrictions: entry.restrictions ?? {},
        exclude: [entry]
      }
    );
    if (target &&
        withinBounds(target.position, target.size, TRUCK_DIMENSIONS) &&
        checkStabilityOnPlace(target.position, target.size)) {
      applyPlacement(entry, target);
      setLayoutVersion(prev => prev + 1);
    }
    return entry;
  }, [addBoxFromType, applyPlacement, checkStabilityOnPlace]);

  const addBox = useCallback(() => {
    addBoxAtBestFit(selectedBoxType);
  }, [selectedBoxType, addBoxAtBestFit]);

  // ── Export Load Plan ───────────────────────────────────────────────────────
  const exportLoadPlan = () => {
    const boxesPayload = cargoRegistryRef.current.map((entry, index) => {
      const volume = entry.dimensions.width * entry.dimensions.height * entry.dimensions.depth;
      return {
        index: index + 1, id: entry.id, type: entry.type, label: entry.label,
        fragile: entry.fragile ?? false,  // US5
        restrictions: { ...(entry.restrictions ?? {}) },  // US7 — was missing, so an exported
                                                            // plan silently lost No-Stack /
                                                            // This-Side-Up on the way out
        color: entry.baseMaterial?.color ? `#${entry.baseMaterial.color.getHexString()}` : '#888888',
        physics: { ...(entry.physics ?? {}) },
        dimensions: {
          width:  Number(entry.dimensions.width.toFixed(3)),
          height: Number(entry.dimensions.height.toFixed(3)),
          depth:  Number(entry.dimensions.depth.toFixed(3))
        },
        position: {
          x: Number(entry.mesh.position.x.toFixed(3)),
          y: Number(entry.mesh.position.y.toFixed(3)),
          z: Number(entry.mesh.position.z.toFixed(3))
        },
        rotation: {
          x: Number(entry.mesh.rotation.x.toFixed(3)),
          y: Number(entry.mesh.rotation.y.toFixed(3)),
          z: Number(entry.mesh.rotation.z.toFixed(3))
        },
        volumeFt3: Number(volume.toFixed(3))
      };
    });
    const payload = {
      generatedAt: new Date().toISOString(),
      truck: { ...TRUCK_DIMENSIONS, totalVolumeFt3: Number(TRUCK_VOLUME.toFixed(3)) },
      summary: {
        totalBoxes: boxesPayload.length,
        totalVolumeUsedFt3: Number(usedVolume.toFixed(3)),
        utilizationPercent: Number(volumePercentage)
      },
      boxes: boxesPayload
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'load-plan.json';
    document.body.appendChild(link); link.click();
    document.body.removeChild(link); URL.revokeObjectURL(url);
  };

  // ── Clear Boxes ────────────────────────────────────────────────────────────
  const clearBoxes = useCallback(({ clearQueue = true } = {}) => {
    dragControllerRef.current?.clearRegistry();
    const physicsWorld = physicsApiRef.current?.world;
    [...cargoRegistryRef.current].forEach(e => {
      if (e?.body && physicsWorld) physicsWorld.removeBody(e.body);
      if (sceneRef.current && e?.mesh) sceneRef.current.remove(e.mesh);
      e.mesh?.clear();
    });
    cargoRegistryRef.current.length = 0;
    ghostPreviewRef.current?.hide();
    setSuggestion(null);
    setSuggestionCandidates([]);
    setSearchDiagnostics(null);
    suggestionTargetRef.current = null;
    setBoxes([]);
    setStats(prev => ({ ...prev, boxCount: 0 }));
    setFragileWarning(null);
    setStabilityWarning(null);
    setOrientEntry(null);
    setSelectedGroupIds([]);
    setLayoutVersion(prev => prev + 1);
    if (clearQueue) {
      setBoxQueue([]); setQueueSummary([]);
      setSelectedExampleName('Manual'); setSelectedExampleId(null);
    }
    clearHistory();
  }, [clearHistory]);

  // ── US1 Yash: load example select ─────────────────────────────────────────
  const handleLoadExampleSelect = useCallback((exampleId) => {
    const example = STEELCASE_LOAD_EXAMPLES.find(e => e.id === exampleId);
    if (!example) return;
    clearBoxes({ clearQueue: false });
    const queued       = buildQueueFromExample(example);
    const runtimeTypes = example.boxes.map((boxDef, i) => mapSteelcaseBoxToRuntimeType(example.id, boxDef, i));
    setSelectedExampleName(example.name);
    setSelectedExampleId(example.id);
    setAvailableBoxes(runtimeTypes);
    setSelectedBoxType(runtimeTypes[0]);
    setBoxQueue(queued);
    setQueueSummary(buildQueueSummary(queued));
    setActiveStopFilter(null);
  }, [buildQueueFromExample, buildQueueSummary, clearBoxes]);

  // ── US1 Yash: add next queued box ─────────────────────────────────────────
  const addNextQueuedBox = useCallback(() => {
    if (boxQueue.length === 0) { addBox(); return; }
    const nextType = boxQueue[0];
    if (addBoxAtBestFit(nextType)) {
      setBoxQueue(prev => {
        const updated = prev.slice(1);
        setQueueSummary(buildQueueSummary(updated));
        if (updated.length > 0) setSelectedBoxType(updated[0]);
        return updated;
      });
    }
  }, [boxQueue, addBox, addBoxAtBestFit, buildQueueSummary]);

  // Reorder the pending queue heaviest-first, fragile last. Arrival order — not
  // the scoring function — is what strands heavy cartons near the roof, because
  // by the time they show up the deck is already full.
  const sortQueueForPacking = useCallback(() => {
    setBoxQueue(prev => {
      if (prev.length < 2) return prev;
      const sorted = suggestLoadOrder(prev);
      setQueueSummary(buildQueueSummary(sorted));
      setSelectedBoxType(sorted[0]);
      return sorted;
    });
  }, [buildQueueSummary]);

  // ── Autofill: keep best-fitting boxes in until the trailer genuinely has no
  //    room left ─────────────────────────────────────────────────────────────
  //
  // "Add box" / "Add next box" already place a single carton at its AI Best
  // Fit spot (addBoxAtBestFit), but when nothing fits they still leave that
  // carton floating at its spawn slot rather than fitting it somewhere else or
  // giving up cleanly. Autofill needs the opposite: if a carton has nowhere
  // legal to go right now, pull it back out and try the next one instead of
  // dumping it in the trailer, and only stop once an entire pass over every
  // remaining candidate placed nothing.
  const removeUnplacedEntry = useCallback((entry) => {
    const physicsWorld = physicsApiRef.current?.world;
    if (entry.body && physicsWorld) physicsWorld.removeBody(entry.body);
    if (sceneRef.current && entry.mesh) sceneRef.current.remove(entry.mesh);
    entry.mesh?.clear();
    const idx = cargoRegistryRef.current.indexOf(entry);
    if (idx >= 0) cargoRegistryRef.current.splice(idx, 1);
    setBoxes(prev => prev.filter(b => b.id !== entry.id));
    setStats(prev => ({ ...prev, boxCount: Math.max(0, prev.boxCount - 1) }));
  }, []);

  // Spawn one carton of `boxType` and either settle it into a real Best Fit
  // spot (returning true) or undo the spawn entirely (returning false) —
  // Autofill only ever wants a hard yes/no per carton, never a floating one.
  const tryAutofillOne = useCallback((boxType) => {
    const entry = addBoxFromType(boxType);
    if (!entry || !fitSuggestionRef.current) return false;

    const dims = entry.dimensions;
    const target = fitSuggestionRef.current.findBestFit(
      { x: dims.width, y: dims.height, z: dims.depth },
      {
        mass: entry.physics?.mass ?? estimateMass(entry.size),
        fragile: entry.fragile ?? false,
        restrictions: entry.restrictions ?? {},   // US7
        exclude: [entry]
      }
    );
    if (target &&
        withinBounds(target.position, target.size, TRUCK_DIMENSIONS) &&
        checkStabilityOnPlace(target.position, target.size)) {
      applyPlacement(entry, target);
      return true;
    }
    removeUnplacedEntry(entry);
    return false;
  }, [addBoxFromType, applyPlacement, checkStabilityOnPlace, removeUnplacedEntry]);

  // Fills the trailer one carton per animation frame (same pattern as the
  // stress test below) so the search's ~200 ms-per-carton budget never
  // freezes the tab. Drains the queue first — skipping, not discarding,
  // anything that does not currently fit so a later/smaller queued carton
  // still gets its turn — then keeps topping up from whatever box types still
  // have quantity left, heaviest/bulkiest first, until a full pass places
  // nothing at all.
  const handleAutofill = useCallback(() => {
    if (isAutofilling) return;
    setIsAutofilling(true);

    let queue = [...boxQueue];
    let queueStall = 0;

    const finish = (finalQueue) => {
      setBoxQueue(finalQueue);
      setQueueSummary(buildQueueSummary(finalQueue));
      if (finalQueue.length > 0) setSelectedBoxType(finalQueue[0]);
      setIsAutofilling(false);
    };

    // Phase 2: once the queue is drained (or stuck), keep topping up from
    // whatever box types still have quantity left, heaviest/bulkiest-first
    // (same ordering "Sort queue by weight" uses), stopping once one full
    // pass over them places nothing at all.
    const runFillPass = (candidates, i, anyPlaced) => {
      if (cargoRegistryRef.current.length >= MAX_BOXES) { finish(queue); return; }
      if (i >= candidates.length) {
        if (!anyPlaced) { finish(queue); return; }
        requestAnimationFrame(fillRemaining);
        return;
      }
      const placed = tryAutofillOne(candidates[i]);
      requestAnimationFrame(() => runFillPass(candidates, i + 1, anyPlaced || placed));
    };

    const fillRemaining = () => {
      if (cargoRegistryRef.current.length >= MAX_BOXES) { finish(queue); return; }
      const candidates = suggestLoadOrder(
        availableBoxes.filter(c => {
          const loaded = cargoRegistryRef.current.filter(e => e.type === c.id).length;
          return (c.availableQty ?? Infinity) - loaded > 0;
        })
      );
      if (candidates.length === 0) { finish(queue); return; }
      runFillPass(candidates, 0, false);
    };

    // Phase 1: drain the queue one carton per animation frame (so the
    // search's ~200 ms-per-carton budget never freezes the tab), skipping —
    // not discarding — anything that does not currently fit so a
    // later/smaller queued carton still gets its turn. Stops once a full lap
    // over the current queue places nothing, and moves on to phase 2.
    const drainQueue = () => {
      if (cargoRegistryRef.current.length >= MAX_BOXES) { finish(queue); return; }
      if (queue.length === 0 || queueStall >= queue.length) {
        requestAnimationFrame(fillRemaining);
        return;
      }
      const [next, ...rest] = queue;
      const placed = tryAutofillOne(next);
      if (placed) { queue = rest; queueStall = 0; }
      else { queue = [...rest, next]; queueStall += 1; }
      requestAnimationFrame(drainQueue);
    };

    requestAnimationFrame(drainQueue);
  }, [isAutofilling, boxQueue, availableBoxes, buildQueueSummary, tryAutofillOne]);

  // ── US6 Yash: stress test ──────────────────────────────────────────────────
  const runStressTest = useCallback(() => {
    if (isStressTestRunning) return;
    setIsStressTestRunning(true); setStressResult(null);
    clearBoxes({ clearQueue: false });
    const sourceTypes = boxQueue.length > 0 ? [...boxQueue] : [...availableBoxes];
    if (!sourceTypes.length) { setIsStressTestRunning(false); return; }
    let i = 0;
    const startFpsSampling = () => {
      const samples = []; const start = performance.now();
      const iv = window.setInterval(() => {
        samples.push(statsRef.current.fps);
        if (performance.now() - start >= 5000) {
          window.clearInterval(iv);
          const avgFps = Math.round(samples.reduce((s, f) => s + f, 0) / Math.max(samples.length, 1));
          const minFps = samples.length ? Math.min(...samples) : 0;
          setStressResult({ boxCount: STRESS_TEST_TARGET, avgFps, minFps, passed: avgFps >= 30 && minFps >= 30 });
          setIsStressTestRunning(false);
        }
      }, 500);
    };
    const spawnStep = () => {
      if (i < STRESS_TEST_TARGET) { addBoxFromType(sourceTypes[i % sourceTypes.length]); i++; requestAnimationFrame(spawnStep); }
      else startFpsSampling();
    };
    requestAnimationFrame(spawnStep);
  }, [availableBoxes, boxQueue, isStressTestRunning, addBoxFromType, clearBoxes]);

  const computeSessionSummaryMetrics = useCallback(() => {
    const entries = cargoRegistryRef.current;
    if (!entries.length) return null;

    const cargoVolume = entries.reduce(
      (total, e) => total + (e.dimensions.width * e.dimensions.height * e.dimensions.depth),
      0
    );
    const optimalSpaceUsedPct = (cargoVolume / TRUCK_VOLUME) * 100;

    const minX = Math.min(...entries.map(e => e.mesh.position.x - e.size.x / 2));
    const maxX = Math.max(...entries.map(e => e.mesh.position.x + e.size.x / 2));
    const minY = Math.min(...entries.map(e => e.mesh.position.y - e.size.y / 2));
    const maxY = Math.max(...entries.map(e => e.mesh.position.y + e.size.y / 2));
    const minZ = Math.min(...entries.map(e => e.mesh.position.z - e.size.z / 2));
    const maxZ = Math.max(...entries.map(e => e.mesh.position.z + e.size.z / 2));

    const arrangementVolume = Math.max(0, (maxX - minX) * (maxY - minY) * (maxZ - minZ));
    const userSpaceUsedPct = Math.min(100, (arrangementVolume / TRUCK_VOLUME) * 100);
    const wastedSpacePct = Math.max(0, ((arrangementVolume - cargoVolume) / TRUCK_VOLUME) * 100);
    const efficiencyDeltaPct = optimalSpaceUsedPct - userSpaceUsedPct;

    return {
      totalBoxes: entries.length,
      optimalSpaceUsedPct,
      userSpaceUsedPct,
      wastedSpacePct,
      efficiencyDeltaPct
    };
  }, []);

  const handleFinishSession = useCallback(() => {
    const metrics = computeSessionSummaryMetrics();
    if (!metrics) return;
    initialLoadSnapshotRef.current = cargoRegistryRef.current.map(e => ({
      type: e.type,
      fragile: e.fragile,
      restrictions: { ...(e.restrictions ?? {}) },  // US7
      label: e.label,
      position: e.mesh.position.clone(),
      rotation: e.mesh.rotation.clone(),
      dimensions: { ...e.dimensions },
      physics: { ...e.physics },
      color: e.baseMaterial?.color ? '#' + e.baseMaterial.color.getHexString() : '#888'
    }));
    setSessionSummaryMetrics(metrics);
    setShowSessionSummary(true);
  }, [computeSessionSummaryMetrics]);

  const handleTryAgain = useCallback(() => {
    const snapshot = initialLoadSnapshotRef.current;
    clearBoxes({ clearQueue: false });
    setShowSessionComplete(false);
    if (!snapshot?.length) return;
    setTimeout(() => {
      snapshot.forEach(({ type, fragile, restrictions, label, position, rotation, dimensions, physics, color }) => {
        if (!sceneRef.current) return;
        const boxType = { id: type, label, color, dimensions, physics, fragile: fragile ?? false };
        const isFragile = fragile ?? false;
        const restr = restrictions ?? {};   // US7
        const mesh = new THREE.Mesh(getSharedGeometry(dimensions), getSharedMaterial(boxType));
        mesh.position.copy(position);
        mesh.rotation.copy(rotation);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.add(new THREE.LineSegments(getSharedEdges(dimensions), isFragile ? fragilePinkLineRef.current : lineMaterialRef.current));
        if (isFragile) mesh.add(createFragileLabel(dimensions.height));
        if (restr.noStack) mesh.add(createNoStackLabel(dimensions.height, isFragile ? 0.34 : 0));
        if (restr.thisSideUp) mesh.add(createThisSideUpLabel(dimensions.height, (isFragile ? 0.34 : 0) + (restr.noStack ? 0.34 : 0)));
        sceneRef.current.add(mesh);
        const body = createBoxBody(boxType, mesh);
        const entry = {
          id: `${type}-tryagain-${Date.now()}-${Math.random()}`,
          type,
          label,
          mesh,
          body,
          size: { x: dimensions.width, y: dimensions.height, z: dimensions.depth },
          dimensions: { ...dimensions },
          physics: { ...physics },
          fragile: isFragile,
          restrictions: { ...restr },   // US7
          baseMaterial: getSharedMaterial(boxType)
        };
        cargoRegistryRef.current.push(entry);
        setBoxes(prev => [...prev, { id: entry.id, mesh, type }]);
        setStats(prev => ({ ...prev, boxCount: prev.boxCount + 1 }));
      });
    }, 50);
  }, [clearBoxes]);

  // ── US4 Rhea (Sprint 6 carry-over): Import Confirmation Preview ───────────
  //
  // Reads a load-plan.json (the shape exportLoadPlan writes), builds a
  // count/volume/type-breakdown summary, and stores it in importPreview for
  // ImportConfirmModal to render. Nothing about the current session is
  // touched here — that only happens in applyImportedLoadPlan, and only
  // after the user explicitly confirms (twice, if boxes are already placed).
  const summarizeImportPlan = useCallback((parsed) => {
    const rawBoxes = Array.isArray(parsed?.boxes) ? parsed.boxes : [];
    const grouped = new Map();
    let totalVolumeFt3 = 0;

    for (const b of rawBoxes) {
      const d = b?.dimensions ?? {};
      const w = Number(d.width)  || 0;
      const h = Number(d.height) || 0;
      const dep = Number(d.depth) || 0;
      const volume = w * h * dep;
      totalVolumeFt3 += volume;

      const key = b?.type ?? b?.label ?? 'Unknown';
      if (!grouped.has(key)) {
        grouped.set(key, {
          label: b?.label ?? key,
          color: b?.color ?? '#888888',
          fragile: !!b?.fragile,
          noStack: !!b?.restrictions?.noStack,
          thisSideUp: !!b?.restrictions?.thisSideUp,
          count: 0,
          volumeFt3: 0
        });
      }
      const g = grouped.get(key);
      g.count += 1;
      g.volumeFt3 += volume;
    }

    return {
      totalBoxes: rawBoxes.length,
      totalVolumeFt3,
      typeBreakdown: Array.from(grouped.values())
    };
  }, []);

  const handleImportLoadPlanFile = useCallback((event) => {
    const file = event?.target?.files?.[0];
    // Always clear the input so re-selecting the same file (e.g. after a
    // cancelled import) fires onChange again.
    if (event?.target) event.target.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      let parsed;
      try {
        parsed = JSON.parse(e.target.result);
      } catch {
        alert('That file is not valid JSON — could not read this load plan.');
        return;
      }
      if (!Array.isArray(parsed?.boxes)) {
        alert('This file doesn\'t look like a load-plan export (missing a "boxes" list).');
        return;
      }

      const summary = summarizeImportPlan(parsed);
      setImportPreview({
        ...summary,
        rawData: parsed,
        fileName: file.name,
        hasExistingBoxes: cargoRegistryRef.current.length > 0,
        existingBoxCount: cargoRegistryRef.current.length
      });
    };
    reader.onerror = () => alert('Could not read that file.');
    reader.readAsText(file);
  }, [summarizeImportPlan]);

  // Reconstructs the scene from a parsed load-plan.json — same reconstruction
  // pattern as handleTryAgain (shared geometry/material caches, physics body,
  // fragile/restriction labels), just sourced from plain JSON position/
  // rotation objects instead of a THREE snapshot, and capped at MAX_BOXES so
  // a huge file can't silently blow past the scene's box limit.
  const applyImportedLoadPlan = useCallback((parsed) => {
    clearBoxes({ clearQueue: true });
    const rawBoxes = Array.isArray(parsed?.boxes) ? parsed.boxes : [];
    const toRestore = rawBoxes.slice(0, MAX_BOXES);
    if (rawBoxes.length > MAX_BOXES) {
      alert(`This file has ${rawBoxes.length} boxes — only the first ${MAX_BOXES} (the scene limit) were restored.`);
    }

    setTimeout(() => {
      toRestore.forEach((b) => {
        if (!sceneRef.current) return;
        const dimensions = {
          width:  Number(b?.dimensions?.width)  || 0,
          height: Number(b?.dimensions?.height) || 0,
          depth:  Number(b?.dimensions?.depth)  || 0
        };
        if (!dimensions.width || !dimensions.height || !dimensions.depth) return;

        const type  = b?.type ?? b?.id ?? 'imported';
        const label = b?.label ?? type;
        const color = b?.color ?? '#888888';
        const isFragile = !!b?.fragile;
        const restr = b?.restrictions ?? {};
        const physics = {
          mass: b?.physics?.mass ?? estimateMass({ x: dimensions.width, y: dimensions.height, z: dimensions.depth }),
          friction: b?.physics?.friction ?? 0.9,
          restitution: b?.physics?.restitution ?? 0.0
        };
        const boxType = { id: type, label, color, dimensions, physics, fragile: isFragile };

        const mesh = new THREE.Mesh(getSharedGeometry(dimensions), getSharedMaterial(boxType));
        mesh.position.set(
          Number(b?.position?.x) || 0,
          Number(b?.position?.y) || (DECK_SURFACE_Y + dimensions.height / 2),
          Number(b?.position?.z) || 0
        );
        mesh.rotation.set(
          Number(b?.rotation?.x) || 0,
          Number(b?.rotation?.y) || 0,
          Number(b?.rotation?.z) || 0
        );
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.add(new THREE.LineSegments(getSharedEdges(dimensions), isFragile ? fragilePinkLineRef.current : lineMaterialRef.current));
        if (isFragile) mesh.add(createFragileLabel(dimensions.height));
        if (restr.noStack) mesh.add(createNoStackLabel(dimensions.height, isFragile ? 0.34 : 0));
        if (restr.thisSideUp) mesh.add(createThisSideUpLabel(dimensions.height, (isFragile ? 0.34 : 0) + (restr.noStack ? 0.34 : 0)));

        sceneRef.current.add(mesh);
        const body = createBoxBody(boxType, mesh);
        const entry = {
          id: `${type}-import-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
          type, label, mesh, body,
          size: { x: dimensions.width, y: dimensions.height, z: dimensions.depth },
          dimensions: { ...dimensions },
          physics: { ...physics },
          fragile: isFragile,
          restrictions: { ...restr },
          baseMaterial: getSharedMaterial(boxType)
        };
        cargoRegistryRef.current.push(entry);
        setBoxes(prev => [...prev, { id: entry.id, mesh, type }]);
        setStats(prev => ({ ...prev, boxCount: prev.boxCount + 1 }));
        setTimeout(() => checkFragileStacking(entry), 100);
      });
      setLayoutVersion(prev => prev + 1);
      setSelectedExampleName('Imported');
      setSelectedExampleId(null);
    }, 50);
  }, [clearBoxes, checkFragileStacking]);

  const handleConfirmImport = useCallback(() => {
    if (!importPreview?.rawData) return;
    applyImportedLoadPlan(importPreview.rawData);
    setImportPreview(null);
  }, [importPreview, applyImportedLoadPlan]);

  // Cancelling never calls applyImportedLoadPlan, so nothing in the scene,
  // registry, or queue has been touched — clearing this back to null is the
  // whole undo (Task 3).
  const handleCancelImport = useCallback(() => {
    setImportPreview(null);
  }, []);

  const handleClearGroup = useCallback(() => {
    dragControllerRef.current?.clearGroup();
    setSelectedGroupIds([]);
  }, []);

  // ── AI Best Fit ────────────────────────────────────────────────────────────
  /**
   * US1 task 3: run a search with the "calculating" indicator up.
   *
   * The search is synchronous and can hold the main thread for ~100 ms on a
   * full trailer, so the spinner has to be on screen BEFORE it starts. Two
   * nested rAFs are what guarantees that: the first runs in the frame React
   * commits the state change, the second only after the browser has painted it.
   * A bare setTimeout could still fire before that paint.
   */
  const runWithSuggestionIndicator = useCallback((work) => {
    setIsCalcSuggestion(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          work();
        } finally {
          setIsCalcSuggestion(false);
        }
      });
    });
  }, []);

  const handleSuggestPlacement = useCallback(() => {
    if (!selectedBoxType) return;
    runWithSuggestionIndicator(() => refreshPlacementSuggestions(true));
  }, [selectedBoxType, refreshPlacementSuggestions, runWithSuggestionIndicator]);

  const performSnapToSuggestion = useCallback(() => {
    if (!suggestion || boxes.length === 0 || !fitSuggestionRef.current) return;
    const lastEntry = cargoRegistryRef.current[cargoRegistryRef.current.length - 1];
    if (!lastEntry) return;

    // US2 acceptance: the carton must end up in the pose the ghost is showing.
    // So prefer the displayed suggestion — but only once it has been re-checked
    // against the registry as it stands now, because the physics world keeps
    // settling after the preview was drawn and the spot can stop being free.
    //
    // We re-solve only when that check fails, and never apply a suggestion that
    // was ranked for a DIFFERENT carton: it was validated for another SKU's
    // dimensions, which is how 48" parcels ended up posed through the trailer
    // wall and under the deck.
    const previewedThisCarton = suggestionTargetRef.current === lastEntry;
    let target = previewedThisCarton &&
                 fitSuggestionRef.current.isStillValid(suggestion, [lastEntry])
      ? suggestion
      : null;

    if (!target) {
      const dims = lastEntry.dimensions;
      target = fitSuggestionRef.current.findBestFit(
        { x: dims.width, y: dims.height, z: dims.depth },
        {
          mass: lastEntry.physics?.mass ?? estimateMass(lastEntry.size),
          fragile: lastEntry.fragile ?? false,
          restrictions: lastEntry.restrictions ?? {},   // US7
          exclude: [lastEntry]
        }
      );
    }

    // If nothing fits this carton right now, say so rather than guessing.
    if (!target) {
      alert('No valid placement found for this box — try rotating it or freeing up space.');
      return;
    }

    // Belt-and-braces: never commit a pose that is not physically inside the
    // trailer. The search already guarantees this, but a silent bad placement
    // (a 4 ft parcel through the sidewall) is far worse than a refused click.
    if (!withinBounds(target.position, target.size, TRUCK_DIMENSIONS)) {
      console.warn('Rejected out-of-bounds suggestion', target.position, target.size);
      alert('No valid placement found for this box — try rotating it or freeing up space.');
      return;
    }

    if (!checkStabilityOnPlace(target.position, target.size)) return;

    const oldPos = lastEntry.mesh.position.clone();
    applyPlacement(lastEntry, target);
    saveToHistoryRef.current?.(lastEntry.mesh, oldPos, target.position);
    setLayoutVersion(prev => prev + 1);
    ghostPreviewRef.current?.hide();
    setSuggestion(null);
    setSuggestionCandidates([]);
    suggestionTargetRef.current = null;
    // US4 Rhea (Task 3): fragile-stacking warning must fire for AI-assisted
    // snap placement too, not just manual drag / initial spawn.
    setTimeout(() => checkFragileStacking(lastEntry), 100);
  }, [suggestion, boxes.length, checkFragileStacking, checkStabilityOnPlace, applyPlacement]);

  // Snapping can fall back to a full re-solve, so it gets the indicator too.
  const handleSnapToSuggestion = useCallback(() => {
    runWithSuggestionIndicator(performSnapToSuggestion);
  }, [performSnapToSuggestion, runWithSuggestionIndicator]);

  const handleUndo = useCallback(() => {
    undo();
    setTimeout(() => setLayoutVersion(prev => prev + 1), 0);
  }, [undo]);

  const handleRedo = useCallback(() => {
    redo();
    setTimeout(() => setLayoutVersion(prev => prev + 1), 0);
  }, [redo]);

  const handleRotateBox = useCallback(() => {
    const dc = dragControllerRef.current;
    if (!dc) return;
    if (orientEntry) dc.rotateEntry(orientEntry);
    else dc.rotateSelected();
  }, [orientEntry]);

  const syncOrientPhysics = useCallback((entry) => {
    dragControllerRef.current?.syncBodyWithMesh(entry);
    setLayoutVersion(prev => prev + 1);
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <Header
        stats={stats} usedVolume={usedVolume} volumePercentage={volumePercentage}
        isBoxDragging={isBoxDragging} historyIndex={historyIndex} history={history}
        undo={handleUndo} redo={handleRedo} selectedExampleName={selectedExampleName} stressResult={stressResult}
      />

      <ControlPanel
        boxes={boxes}
        availableBoxes={filteredBoxes}
        selectedBoxType={selectedBoxType}
        setSelectedBoxType={setSelectedBoxType}
        addBox={addBox}
        clearBoxes={clearBoxes}
        exportLoadPlan={exportLoadPlan}
        onImportLoadPlanFile={handleImportLoadPlanFile}
        isBoxDragging={isBoxDragging}
        orientEntry={orientEntry}
        onRotateBox={handleRotateBox}
        dragControllerRef={dragControllerRef}
        handleCameraView={handleCameraView}
        handleCSVUpload={handleCSVUpload}
        loadExamples={STEELCASE_LOAD_EXAMPLES}
        onSelectLoadExample={handleLoadExampleSelect}
        selectedExampleId={selectedExampleId}
        queueCount={boxQueue.length}
        queueSummary={queueSummary}
        addNextQueuedBox={addNextQueuedBox}
        sortQueueForPacking={sortQueueForPacking}
        onAutofill={handleAutofill}
        isAutofilling={isAutofilling}
        runStressTest={runStressTest}
        isStressTestRunning={isStressTestRunning}
        stressResult={stressResult}
        onSuggestPlacement={handleSuggestPlacement}
        onSnapToSuggestion={handleSnapToSuggestion}
        hasSuggestion={!!suggestion}
        isCalcSuggestion={isCalcSuggestion}
        suggestionCount={suggestionCandidates.length}
        suggestionReasons={suggestionCandidates[0]?.reasons ?? []}
        suggestionOrientation={suggestion?.orientation ?? null}
        searchDiagnostics={searchDiagnostics}
        activeStopFilter={activeStopFilter}
        setActiveStopFilter={setActiveStopFilter}
        onFinishSession={handleFinishSession}
        selectedGroupCount={selectedGroupIds.length}
        onClearGroup={handleClearGroup}
      />

      <main className="stage">
        {/* 3D Canvas */}
        <div ref={mountRef} className="stage-canvas" />

        <div className="stage-toolbar">
          <ControlsGuide
            isOpen={openStagePanel === 'controls'}
            onToggle={() => setOpenStagePanel(p => (p === 'controls' ? null : 'controls'))}
          />
          {/* Becky: Shipment Summary panel */}
          <ShipmentSummary
            availableBoxes={availableBoxes}
            activeStopFilter={activeStopFilter}
            setActiveStopFilter={setActiveStopFilter}
            isOpen={openStagePanel === 'shipment'}
            onToggle={() => setOpenStagePanel(p => (p === 'shipment' ? null : 'shipment'))}
          />
        </div>

        {!isLoading && boxes.length === 0 && !fragileWarning && !stabilityWarning && (
          <div className="empty-state">
            <Icon name="box" size={18} />
            <span>
              {boxQueue.length > 0
                ? <><strong>{boxQueue.length} boxes</strong> are queued. Press <strong>Add next box</strong> to start loading.</>
                : <>Pick a load example or upload a CSV to start loading.</>}
            </span>
          </div>
        )}

        {/* US5 Rhea: fragile stacking warning; stability warning */}
        {(fragileWarning || stabilityWarning) && (
          <div className="toast-stack" role="status" aria-live="polite">
            {fragileWarning && (
              <div className="toast toast-danger">
                <Icon name="alert" className="toast-icon" />
                <span className="toast-msg">{fragileWarning}</span>
                <button type="button" className="btn btn-ghost btn-icon" aria-label="Dismiss" onClick={() => setFragileWarning(null)}>
                  <Icon name="x" size={14} />
                </button>
              </div>
            )}
            {stabilityWarning && (
              <div className={`toast ${stabilityWarning.status === 'blocked' ? 'toast-danger' : 'toast-warning'}`}>
                <Icon name="alert" className="toast-icon" />
                <span className="toast-msg">{stabilityWarning.message}</span>
                {stabilityWarning.status !== 'blocked' && (
                  <button type="button" className="btn btn-ghost btn-icon" aria-label="Dismiss" onClick={() => setStabilityWarning(null)}>
                    <Icon name="x" size={14} />
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Loading overlay */}
        {isLoading && (
          <div className="loading">
            <div>
              <div className="loading-spinner" />
              Loading 3D environment…
            </div>
          </div>
        )}
      </main>

      {orientEntry && (
        <OrientationWidget
          selectedBox={orientEntry}
          widgetPos={orientWidgetPos}
          dragControllerRef={dragControllerRef}
          setSelectedBox={setOrientEntry}
          onPhysicsSync={syncOrientPhysics}
        />
      )}

      <ImportConfirmModal
        open={!!importPreview}
        preview={importPreview}
        onConfirm={handleConfirmImport}
        onCancel={handleCancelImport}
      />

      <SessionSummaryModal
        open={showSessionSummary}
        metrics={sessionSummaryMetrics}
        onClose={() => setShowSessionSummary(false)}
        onTryAgain={handleTryAgain}
        onContinueToGrade={() => {
          setShowSessionSummary(false);
          setShowSessionComplete(true);
        }}
      />

      {showSessionComplete && (
        <SessionCompleteScreen
          usedVolume={usedVolume}
          totalBoxes={boxes.length}
          onTryAgain={handleTryAgain}
          onDismiss={() => setShowSessionComplete(false)}
        />
      )}
    </div>
  );
};

export default TruckLoadingPrototype;
