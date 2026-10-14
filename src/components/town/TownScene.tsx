import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { MapControls, Sky, Stars } from "@react-three/drei";
import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three";
import {
  HOUSES_PER_BLOCK,
  ROAD,
  SIDEWALK,
  TOWN_THEMES,
  hash,
  type Block,
  type HouseLot,
  type ThemePalette,
  type TownLayout,
  type TownTheme,
} from "./townLayout";

export type OpenedHouse = { house: number; result: "ae" | "bomb" | "empty" };
export type CameraView = "aerial" | "street";
export type CameraFocus = { x: number; z: number; facing: number; key: number } | null;

type Controls = { target: THREE.Vector3; update: () => void };

const EYE = 1.6;

/* ---------- shared geometry ---------- */

let sharedGeometries: ReturnType<typeof createGeometries> | null = null;

function useGeometries() {
  return useMemo(() => (sharedGeometries ??= createGeometries()), []);
}

function createGeometries() {
  {
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const centeredBox = new THREE.BoxGeometry(1, 1, 1);
    const roofShape = new THREE.Shape();
    roofShape.moveTo(-0.5, 0);
    roofShape.lineTo(0.5, 0);
    roofShape.lineTo(0, 1);
    roofShape.lineTo(-0.5, 0);
    const roof = new THREE.ExtrudeGeometry(roofShape, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5);
    const facade = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const ground = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const foliage = new THREE.IcosahedronGeometry(1, 1);
    const pine = new THREE.ConeGeometry(1, 1, 7).translate(0, 0.5, 0);
    const trunk = new THREE.CylinderGeometry(0.14, 0.22, 1, 6).translate(0, 0.5, 0);
    const pole = new THREE.CylinderGeometry(0.09, 0.12, 1, 6).translate(0, 0.5, 0);
    const mountain = new THREE.ConeGeometry(1, 1, 9, 3).translate(0, 0.5, 0);
    const sphere = new THREE.SphereGeometry(1, 12, 8);
    const octa = new THREE.OctahedronGeometry(1, 0);
    return { box, centeredBox, roof, facade, ground, foliage, pine, trunk, pole, mountain, sphere, octa };
  }
}

/* ---------- canvas textures ---------- */

function canvasTexture(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void, srgb = true) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx) draw(ctx);
  const texture = new THREE.CanvasTexture(canvas);
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function drawWindow(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, glass: string) {
  ctx.fillStyle = "#f4f1ea";
  ctx.fillRect(x - 4, y - 4, w + 8, h + 8);
  ctx.fillStyle = glass;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#f4f1ea";
  ctx.fillRect(x + w / 2 - 2, y, 4, h);
  ctx.fillRect(x, y + h / 2 - 2, w, 4);
  ctx.fillStyle = "rgba(0,0,0,.25)";
  ctx.fillRect(x - 6, y + h + 4, w + 12, 5);
}

function houseFront(floors: 1 | 2, lit: 0 | 1, windowLit: string) {
  const h = floors === 1 ? 256 : 512;
  const groundY = h - 256;
  const windows = [
    { x: 30, y: groundY + 92, w: 54, h: 62, lit: lit === 0 },
    { x: 172, y: groundY + 92, w: 54, h: 62, lit: lit === 1 },
    ...(floors === 2
      ? [
          { x: 30, y: 110, w: 54, h: 66, lit: lit === 1 },
          { x: 101, y: 110, w: 54, h: 66, lit: false },
          { x: 172, y: 110, w: 54, h: 66, lit: lit === 0 },
        ]
      : []),
  ];
  const map = canvasTexture(256, h, (ctx) => {
    ctx.clearRect(0, 0, 256, h);
    for (const win of windows) drawWindow(ctx, win.x, win.y, win.w, win.h, "#4e6475");
    ctx.fillStyle = "#e9e4da";
    ctx.fillRect(100, groundY + 116, 56, 140);
    ctx.fillStyle = "#5b3a26";
    ctx.fillRect(106, groundY + 122, 44, 134);
    ctx.fillStyle = "#d9b45a";
    ctx.fillRect(140, groundY + 190, 5, 5);
    ctx.fillStyle = "rgba(255,255,255,.18)";
    ctx.fillRect(110, groundY + 130, 36, 24);
  });
  const emissive = canvasTexture(256, h, (ctx) => {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 256, h);
    for (const win of windows) {
      if (!win.lit) continue;
      ctx.fillStyle = windowLit;
      ctx.fillRect(win.x, win.y, win.w, win.h);
    }
    ctx.fillStyle = "#3a2a10";
    ctx.fillRect(110, groundY + 130, 36, 24);
  });
  return { map, emissive };
}

function shopFront(windowLit: string) {
  const map = canvasTexture(256, 256, (ctx) => {
    ctx.clearRect(0, 0, 256, 256);
    for (let i = 0; i < 3; i++) drawWindow(ctx, 22 + i * 78, 34, 52, 50, "#526a7c");
    ctx.fillStyle = "#2b2f33";
    ctx.fillRect(8, 150, 240, 106);
    ctx.fillStyle = "#7f97a8";
    ctx.fillRect(16, 158, 150, 92);
    ctx.fillStyle = "#4b5a66";
    ctx.fillRect(178, 158, 62, 98);
    ctx.fillStyle = "rgba(255,255,255,.22)";
    ctx.fillRect(22, 164, 50, 80);
  });
  const emissive = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = windowLit;
    ctx.fillRect(16, 158, 150, 92);
    ctx.fillRect(178, 158, 62, 98);
    ctx.fillRect(100, 34, 52, 50);
  });
  return { map, emissive };
}

function towerFacade(glass: string, lit: string) {
  const cells = 8;
  const size = 256;
  const step = size / cells;
  const map = canvasTexture(size, size, (ctx) => {
    ctx.fillStyle = "#2d3640";
    ctx.fillRect(0, 0, size, size);
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        const shade = 0.8 + hash(x, y + 40) * 0.35;
        ctx.fillStyle = glass;
        ctx.globalAlpha = shade;
        ctx.fillRect(x * step + 3, y * step + 4, step - 6, step - 9);
      }
    }
    ctx.globalAlpha = 1;
  });
  const emissive = canvasTexture(size, size, (ctx) => {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = lit;
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        if (hash(x * 3, y * 7) < 0.42) ctx.fillRect(x * step + 3, y * step + 4, step - 6, step - 9);
      }
    }
  });
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  emissive.wrapS = emissive.wrapT = THREE.RepeatWrapping;
  return { map, emissive };
}

function glowTexture() {
  return canvasTexture(128, 128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,.45)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  });
}

/* ---------- generic instancing ---------- */

type InstancedProps<T> = {
  items: T[];
  geometry: THREE.BufferGeometry;
  place: (o: THREE.Object3D, item: T, i: number) => void;
  color?: (item: T, i: number) => string;
  children: ReactNode;
  castShadow?: boolean;
  receiveShadow?: boolean;
  onClick?: (event: ThreeEvent<MouseEvent>) => void;
  renderOrder?: number;
};

function Instanced<T>({ items, geometry, place, color, children, castShadow, receiveShadow, onClick, renderOrder }: InstancedProps<T>) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const o = new THREE.Object3D();
    const c = new THREE.Color();
    items.forEach((item, i) => {
      o.position.set(0, 0, 0);
      o.rotation.set(0, 0, 0);
      o.scale.set(1, 1, 1);
      place(o, item, i);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
      if (color) mesh.setColorAt(i, c.set(color(item, i)));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    // place/color are recreated each render; items identity drives updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  if (items.length === 0) return null;
  return (
    <instancedMesh
      key={items.length}
      ref={ref}
      args={[geometry, undefined, items.length]}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
      onClick={onClick}
      renderOrder={renderOrder}
    >
      {children}
    </instancedMesh>
  );
}

/* ---------- houses ---------- */

function Houses({
  layout,
  palette,
  night,
  onHouse,
}: {
  layout: TownLayout;
  palette: ThemePalette;
  night: boolean;
  onHouse: (house: HouseLot) => void;
}) {
  const g = useGeometries();
  const { houses } = layout;
  const fronts = useMemo(
    () => ({
      f1a: houseFront(1, 0, palette.windowLit),
      f1b: houseFront(1, 1, palette.windowLit),
      f2a: houseFront(2, 0, palette.windowLit),
      f2b: houseFront(2, 1, palette.windowLit),
    }),
    [palette.windowLit],
  );
  const groups = useMemo(() => {
    const out = { f1a: [] as HouseLot[], f1b: [] as HouseLot[], f2a: [] as HouseLot[], f2b: [] as HouseLot[] };
    for (const h of houses) {
      const two = h.h > 5;
      const key = `${two ? "f2" : "f1"}${h.litPattern === 0 ? "a" : "b"}` as keyof typeof out;
      out[key].push(h);
    }
    return out;
  }, [houses]);
  const chimneys = useMemo(() => houses.filter((h) => h.chimney), [houses]);
  const trees = useMemo(() => houses.filter((h) => h.tree), [houses]);
  const facing = (h: HouseLot) => (h.rot === 0 ? 1 : -1);

  const click = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    if (event.delta > 8 || event.instanceId === undefined) return;
    const house = houses[event.instanceId];
    if (house) onHouse(house);
  };

  return (
    <group>
      <Instanced
        items={houses}
        geometry={g.box}
        castShadow
        receiveShadow
        onClick={click}
        place={(o, h) => {
          o.position.set(h.x, 0.3, h.z);
          o.rotation.y = h.rot;
          o.scale.set(h.w, h.h, h.d);
        }}
        color={(h) => palette.walls[h.wall % palette.walls.length]}
      >
        <meshStandardMaterial roughness={0.85} />
      </Instanced>
      <Instanced
        items={houses}
        geometry={g.roof}
        castShadow
        onClick={click}
        place={(o, h) => {
          o.position.set(h.x, 0.3 + h.h, h.z);
          o.rotation.y = h.rot;
          o.scale.set(h.w + 0.7, h.roofH, h.d + 0.7);
        }}
        color={(h) => palette.roofs[h.roof % palette.roofs.length]}
      >
        <meshStandardMaterial roughness={0.75} />
      </Instanced>
      {(Object.keys(groups) as (keyof typeof groups)[]).map((key) => (
        <Instanced
          key={key}
          items={groups[key]}
          geometry={g.facade}
          place={(o, h) => {
            const s = facing(h);
            o.position.set(h.x, 0.3, h.z + s * (h.d / 2 + 0.03));
            o.rotation.y = h.rot;
            o.scale.set(h.w * 0.92, h.h, 1);
          }}
        >
          <meshStandardMaterial
            map={fronts[key].map}
            emissiveMap={fronts[key].emissive}
            emissive="#ffffff"
            emissiveIntensity={night ? 1.6 : 0}
            transparent
            alphaTest={0.5}
            roughness={0.45}
          />
        </Instanced>
      ))}
      <Instanced
        items={chimneys}
        geometry={g.box}
        castShadow
        place={(o, h) => {
          const s = facing(h);
          o.position.set(h.x + s * h.w * 0.26, 0.3 + h.h + h.roofH * 0.2, h.z - s * h.d * 0.18);
          o.scale.set(0.6, h.roofH * 0.95, 0.6);
        }}
      >
        <meshStandardMaterial color="#6b5a4e" roughness={0.9} />
      </Instanced>
      <Instanced
        items={houses}
        geometry={g.ground}
        receiveShadow
        place={(o, h) => {
          const s = facing(h);
          o.position.set(h.x, 0.315, h.z + s * (h.d / 2 + 1.2 + SIDEWALK / 2));
          o.scale.set(1.3, 1, 2.4 + SIDEWALK);
        }}
      >
        <meshStandardMaterial color="#c9c3b6" roughness={0.95} />
      </Instanced>
      {[-1, 1].map((side) => (
        <Instanced
          key={side}
          items={houses}
          geometry={g.box}
          castShadow
          place={(o, h) => {
            const s = facing(h);
            const len = layout.lotW / 2 - 1.1;
            o.position.set(h.x + side * (0.75 + len / 2), 0.3, h.z + s * (h.d / 2 + 2.25));
            o.scale.set(len, 0.75, 0.55);
          }}
          color={(h) => (hash(h.index, 12 + side) < 0.5 ? "#3f6b2f" : "#4a7a36")}
        >
          <meshStandardMaterial roughness={1} />
        </Instanced>
      ))}
      <Instanced
        items={trees}
        geometry={g.trunk}
        castShadow
        place={(o, h) => {
          const t = h.tree!;
          o.position.set(t.x, 0.3, t.z);
          o.scale.set(t.s, 2.4 * t.s, t.s);
        }}
      >
        <meshStandardMaterial color="#5a4030" roughness={1} />
      </Instanced>
      <Instanced
        items={trees}
        geometry={g.foliage}
        castShadow
        place={(o, h) => {
          const t = h.tree!;
          o.position.set(t.x, 0.3 + 3.4 * t.s, t.z);
          o.scale.set(1.9 * t.s, 1.7 * t.s, 1.9 * t.s);
          o.rotation.y = t.x;
        }}
        color={(h) => ["#3e6b2c", "#4f7d33", "#5c8a3a", "#36602a"][h.index % 4]}
      >
        <meshStandardMaterial roughness={0.95} flatShading />
      </Instanced>
    </group>
  );
}

/* ---------- ground, blocks, roads ---------- */

function Ground({ layout, palette, night }: { layout: TownLayout; palette: ThemePalette; night: boolean }) {
  const g = useGeometries();
  const { bounds, blocks, blockW, blockD, roadsX, roadsZ, pitchX, pitchZ, downtown, mainRoadX, mainRoadZ } = layout;
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const green = blocks.filter((b) => b.kind === "res" || b.kind === "park" || b.kind === "empty");
  const plaza = blocks.filter((b) => b.kind === "shop" || b.kind === "tower");

  const markings = useMemo(() => {
    const dashes: { x: number; z: number; along: "x" | "z" }[] = [];
    const lines: { x: number; z: number; along: "x" | "z"; len: number; off: number }[] = [];
    const near = (v: number, origin: number, pitch: number) => {
      const m = (((v - origin) % pitch) + pitch) % pitch;
      return m < ROAD / 2 + 1.5 || m > pitch - (ROAD / 2 + 1.5);
    };
    roadsX.forEach((rx, k) => {
      if (k === mainRoadX) {
        for (let m = 0; m < roadsZ.length - 1; m++) {
          const z0 = roadsZ[m] + ROAD / 2;
          const z1 = roadsZ[m + 1] - ROAD / 2;
          for (const off of [-0.2, 0.2]) lines.push({ x: rx + off, z: (z0 + z1) / 2, along: "z", len: z1 - z0, off });
        }
        return;
      }
      for (let z = bounds.minZ; z < bounds.maxZ; z += 8) if (!near(z, roadsZ[0], pitchZ)) dashes.push({ x: rx, z, along: "z" });
    });
    roadsZ.forEach((rz, k) => {
      if (k === mainRoadZ) {
        for (let m = 0; m < roadsX.length - 1; m++) {
          const x0 = roadsX[m] + ROAD / 2;
          const x1 = roadsX[m + 1] - ROAD / 2;
          for (const off of [-0.2, 0.2]) lines.push({ x: (x0 + x1) / 2, z: rz + off, along: "x", len: x1 - x0, off });
        }
        return;
      }
      for (let x = bounds.minX; x < bounds.maxX; x += 8) if (!near(x, roadsX[0], pitchX)) dashes.push({ x, z: rz, along: "x" });
    });
    return { dashes, lines };
  }, [bounds, roadsX, roadsZ, pitchX, pitchZ, mainRoadX, mainRoadZ]);

  const crosswalks = useMemo(() => {
    const out: { x: number; z: number; along: "x" | "z" }[] = [];
    for (let k = downtown.iMin; k <= downtown.iMax; k++) {
      for (let m = downtown.jMin; m <= downtown.jMax; m++) {
        const rx = roadsX[k];
        const rz = roadsZ[m];
        if (rx === undefined || rz === undefined) continue;
        for (let s = -3.6; s <= 3.6; s += 1.2) {
          out.push({ x: rx + s, z: rz - ROAD / 2 - 1.4, along: "z" });
          out.push({ x: rx + s, z: rz + ROAD / 2 + 1.4, along: "z" });
          out.push({ x: rx - ROAD / 2 - 1.4, z: rz + s, along: "x" });
          out.push({ x: rx + ROAD / 2 + 1.4, z: rz + s, along: "x" });
        }
      }
    }
    return out;
  }, [downtown, roadsX, roadsZ]);

  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[cx, -0.6, cz]} receiveShadow>
        <planeGeometry args={[9000, 9000]} />
        <meshStandardMaterial color={palette.ground} roughness={1} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[cx, 0, cz]} receiveShadow>
        <planeGeometry args={[width + 40, depth + 40]} />
        <meshStandardMaterial color={palette.road} roughness={0.92} />
      </mesh>
      <Instanced items={blocks} geometry={g.box} receiveShadow place={(o, b: Block) => { o.position.set(b.x, 0, b.z); o.scale.set(blockW, 0.25, blockD); }}>
        <meshStandardMaterial color={palette.sidewalk} roughness={0.9} />
      </Instanced>
      <Instanced items={green} geometry={g.box} receiveShadow place={(o, b: Block) => { o.position.set(b.x, 0.25, b.z); o.scale.set(blockW - SIDEWALK * 2, 0.05, blockD - SIDEWALK * 2); }}>
        <meshStandardMaterial color={palette.grass} roughness={1} />
      </Instanced>
      <Instanced items={plaza} geometry={g.box} receiveShadow place={(o, b: Block) => { o.position.set(b.x, 0.25, b.z); o.scale.set(blockW - SIDEWALK * 2, 0.04, blockD - SIDEWALK * 2); }}>
        <meshStandardMaterial color="#a9a59c" roughness={0.85} />
      </Instanced>
      <Instanced items={markings.dashes} geometry={g.ground} place={(o, d) => { o.position.set(d.x, 0.06, d.z); o.scale.set(d.along === "z" ? 0.22 : 3.2, 1, d.along === "z" ? 3.2 : 0.22); }}>
        <meshStandardMaterial color="#e8e6df" roughness={0.6} emissive="#ffffff" emissiveIntensity={night ? 0.05 : 0} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
      </Instanced>
      <Instanced items={markings.lines} geometry={g.ground} place={(o, l) => { o.position.set(l.x, 0.06, l.z); o.scale.set(l.along === "z" ? 0.16 : l.len, 1, l.along === "z" ? l.len : 0.16); }}>
        <meshStandardMaterial color="#e5b630" roughness={0.6} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
      </Instanced>
      <Instanced items={crosswalks} geometry={g.ground} place={(o, c) => { o.position.set(c.x, 0.1, c.z); o.scale.set(c.along === "z" ? 0.6 : 2.4, 1, c.along === "z" ? 2.4 : 0.6); }}>
        <meshStandardMaterial color="#f1efe8" roughness={0.6} polygonOffset polygonOffsetFactor={-4} polygonOffsetUnits={-4} />
      </Instanced>
    </group>
  );
}

/* ---------- street lights & traffic lights ---------- */

function StreetLights({ layout, palette, night }: { layout: TownLayout; palette: ThemePalette; night: boolean }) {
  const g = useGeometries();
  const glow = useMemo(() => glowTexture(), []);
  const lamps = useMemo(() => {
    const out: { x: number; z: number; dx: number; dz: number }[] = [];
    for (const b of layout.blocks) {
      const ex = layout.blockW / 2 - 0.6;
      const ez = layout.blockD / 2 - 0.6;
      out.push({ x: b.x - ex, z: b.z - ez, dx: 0, dz: -1 });
      out.push({ x: b.x + ex, z: b.z + ez, dx: 0, dz: 1 });
      out.push({ x: b.x + ex, z: b.z - ez, dx: 1, dz: 0 });
      out.push({ x: b.x - ex, z: b.z + ez, dx: -1, dz: 0 });
    }
    return out;
  }, [layout]);
  return (
    <group>
      <Instanced items={lamps} geometry={g.pole} castShadow place={(o, l) => { o.position.set(l.x, 0.25, l.z); o.scale.set(1, 7, 1); }}>
        <meshStandardMaterial color="#3d4248" metalness={0.6} roughness={0.4} />
      </Instanced>
      <Instanced items={lamps} geometry={g.centeredBox} place={(o, l) => { o.position.set(l.x + l.dx * 1.1, 7.2, l.z + l.dz * 1.1); o.scale.set(l.dx ? 2.4 : 0.5, 0.25, l.dz ? 2.4 : 0.5); }}>
        <meshStandardMaterial color="#3d4248" metalness={0.6} roughness={0.4} />
      </Instanced>
      <Instanced items={lamps} geometry={g.centeredBox} place={(o, l) => { o.position.set(l.x + l.dx * 2, 7.05, l.z + l.dz * 2); o.scale.set(0.7, 0.12, 0.7); }}>
        <meshStandardMaterial color="#fff6e0" emissive={palette.windowLit} emissiveIntensity={night ? 3 : 0} />
      </Instanced>
      {night && (
        <Instanced items={lamps} geometry={g.ground} renderOrder={2} place={(o, l) => { o.position.set(l.x + l.dx * 2.4, 0.3, l.z + l.dz * 2.4); o.scale.set(13, 1, 13); }}>
          <meshBasicMaterial map={glow} color={palette.windowLit} transparent opacity={0.42} depthWrite={false} blending={THREE.AdditiveBlending} polygonOffset polygonOffsetFactor={-6} polygonOffsetUnits={-6} />
        </Instanced>
      )}
    </group>
  );
}

function TrafficLights({ layout }: { layout: TownLayout }) {
  const g = useGeometries();
  const lampRef = useRef<THREE.InstancedMesh>(null);
  const signals = useMemo(() => {
    const out: { x: number; z: number; axis: "x" | "z" }[] = [];
    const { downtown, roadsX, roadsZ } = layout;
    for (let k = downtown.iMin; k <= downtown.iMax; k++) {
      for (let m = downtown.jMin; m <= downtown.jMax; m++) {
        const rx = roadsX[k];
        const rz = roadsZ[m];
        if (rx === undefined || rz === undefined) continue;
        out.push({ x: rx - ROAD / 2 - 0.7, z: rz - ROAD / 2 - 0.7, axis: "z" });
        out.push({ x: rx + ROAD / 2 + 0.7, z: rz + ROAD / 2 + 0.7, axis: "z" });
        out.push({ x: rx + ROAD / 2 + 0.7, z: rz - ROAD / 2 - 0.7, axis: "x" });
        out.push({ x: rx - ROAD / 2 - 0.7, z: rz + ROAD / 2 + 0.7, axis: "x" });
      }
    }
    return out;
  }, [layout]);
  const phase = useRef(-1);
  const o = useMemo(() => new THREE.Object3D(), []);
  const c = useMemo(() => new THREE.Color(), []);
  useFrame(({ clock }) => {
    const mesh = lampRef.current;
    if (!mesh) return;
    const t = clock.elapsedTime % 16;
    const p = t < 6.5 ? 0 : t < 8 ? 1 : t < 14.5 ? 2 : 3;
    if (p === phase.current) return;
    phase.current = p;
    signals.forEach((s, i) => {
      const zGreen = p === 0;
      const zYellow = p === 1;
      const xGreen = p === 2;
      const xYellow = p === 3;
      const state = s.axis === "z" ? (zGreen ? "g" : zYellow ? "y" : "r") : xGreen ? "g" : xYellow ? "y" : "r";
      const y = state === "r" ? 5.6 : state === "y" ? 5.15 : 4.7;
      o.position.set(s.x, y, s.z);
      o.scale.setScalar(0.18);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
      mesh.setColorAt(i, c.set(state === "r" ? "#ff2a1a" : state === "y" ? "#ffb21a" : "#2bff6a"));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });
  return (
    <group>
      <Instanced items={signals} geometry={g.pole} castShadow place={(o2, s) => { o2.position.set(s.x, 0.25, s.z); o2.scale.set(1.1, 4.3, 1.1); }}>
        <meshStandardMaterial color="#2f3337" metalness={0.5} roughness={0.5} />
      </Instanced>
      <Instanced items={signals} geometry={g.centeredBox} place={(o2, s) => { o2.position.set(s.x, 5.15, s.z); o2.scale.set(0.55, 1.55, 0.55); }}>
        <meshStandardMaterial color="#1b1d20" roughness={0.6} />
      </Instanced>
      <instancedMesh ref={lampRef} args={[g.sphere, undefined, signals.length]} frustumCulled={false}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

/* ---------- downtown ---------- */

function Downtown({ layout, palette, night }: { layout: TownLayout; palette: ThemePalette; night: boolean }) {
  const g = useGeometries();
  const shopTex = useMemo(() => shopFront(palette.windowLit), [palette.windowLit]);
  const shops = useMemo(() => {
    const out: { x: number; z: number; rot: number; w: number; h: number; d: number; color: string; awning: string }[] = [];
    let n = 0;
    for (const b of layout.blocks.filter((bl) => bl.kind === "shop")) {
      for (let row = 0; row < 2; row++) {
        for (let a = 0; a < 4; a++) {
          const facingNorth = row === 0;
          const d = layout.blockD / 2 - SIDEWALK - 1.5;
          const front = facingNorth ? b.z - layout.blockD / 2 : b.z + layout.blockD / 2;
          const inward = facingNorth ? 1 : -1;
          n++;
          out.push({
            x: b.x + (a - 1.5) * layout.lotW,
            z: front + inward * (SIDEWALK + 0.4 + d / 2),
            rot: facingNorth ? Math.PI : 0,
            w: layout.lotW - 0.3,
            h: 7.5 + hash(n, 20) * 5,
            d,
            color: ["#e3d8c6", "#cfc4b2", "#d8cdbd", "#bfb3a2", "#e8e1d3"][n % 5],
            awning: palette.awnings[n % palette.awnings.length],
          });
        }
      }
    }
    return out;
  }, [layout, palette.awnings]);
  const towers = useMemo(() => {
    const out: { x: number; z: number; w: number; d: number; h: number }[] = [];
    let n = 0;
    for (const b of layout.blocks.filter((bl) => bl.kind === "tower")) {
      for (const [ox, oz] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]] as const) {
        n++;
        const w = layout.blockW * 0.36;
        const d = layout.blockD * 0.34;
        out.push({ x: b.x + ox * layout.blockW, z: b.z + oz * layout.blockD, w, d, h: 30 + hash(n, 30) * 70 });
      }
    }
    return out;
  }, [layout]);
  const glass = palette.name.includes("賽博") ? "#3b3f7a" : "#6d8aa3";
  const towerMaterials = useMemo(
    () =>
      towers.map((t) => {
        const base = towerFacade(glass, palette.windowLit);
        const map = base.map.clone();
        const emissive = base.emissive.clone();
        map.repeat.set(Math.max(1, Math.round(t.w / 8)), Math.max(1, Math.round(t.h / 10)));
        emissive.repeat.copy(map.repeat);
        map.needsUpdate = true;
        emissive.needsUpdate = true;
        return { map, emissive };
      }),
    [towers, glass, palette.windowLit],
  );
  const parks = layout.blocks.filter((b) => b.kind === "park");
  const parkTrees = useMemo(() => {
    const out: { x: number; z: number; s: number }[] = [];
    parks.forEach((p, pi) => {
      for (let k = 0; k < 26; k++) {
        const angle = (k / 26) * Math.PI * 2;
        const rx = layout.blockW * 0.4;
        const rz = layout.blockD * 0.38;
        out.push({ x: p.x + Math.cos(angle) * rx * (0.85 + hash(k, pi) * 0.15), z: p.z + Math.sin(angle) * rz, s: 0.9 + hash(k, pi + 9) * 0.7 });
      }
    });
    for (const b of layout.blocks.filter((bl) => bl.kind === "shop")) {
      for (let k = -2; k <= 2; k++) {
        out.push({ x: b.x + k * layout.lotW, z: b.z - layout.blockD / 2 + 0.8, s: 0.7 });
        out.push({ x: b.x + k * layout.lotW, z: b.z + layout.blockD / 2 - 0.8, s: 0.7 });
      }
    }
    return out;
  }, [parks, layout]);

  return (
    <group>
      <Instanced items={shops} geometry={g.box} castShadow receiveShadow place={(o, s) => { o.position.set(s.x, 0.3, s.z); o.rotation.y = s.rot; o.scale.set(s.w, s.h, s.d); }} color={(s) => s.color}>
        <meshStandardMaterial roughness={0.8} />
      </Instanced>
      <Instanced items={shops} geometry={g.facade} place={(o, s) => { const k = s.rot === 0 ? 1 : -1; o.position.set(s.x, 0.3, s.z + k * (s.d / 2 + 0.03)); o.rotation.y = s.rot; o.scale.set(s.w * 0.96, Math.min(s.h, 8), 1); }}>
        <meshStandardMaterial map={shopTex.map} emissiveMap={shopTex.emissive} emissive="#ffffff" emissiveIntensity={night ? 1.4 : 0.05} transparent alphaTest={0.5} roughness={0.35} />
      </Instanced>
      <Instanced items={shops} geometry={g.centeredBox} castShadow place={(o, s) => { const k = s.rot === 0 ? 1 : -1; o.position.set(s.x, 3.55, s.z + k * (s.d / 2 + 0.9)); o.rotation.set(k * 0.32, 0, 0); o.scale.set(s.w * 0.9, 0.14, 1.9); }} color={(s) => s.awning}>
        <meshStandardMaterial roughness={0.7} />
      </Instanced>
      <Instanced items={shops} geometry={g.centeredBox} place={(o, s) => { const k = s.rot === 0 ? 1 : -1; o.position.set(s.x, 4.75, s.z + k * (s.d / 2 + 0.15)); o.scale.set(s.w * 0.62, 0.9, 0.22); }} color={(s) => s.awning}>
        <meshStandardMaterial emissive="#ffffff" emissiveIntensity={night ? 0.55 : 0.08} roughness={0.4} />
      </Instanced>
      <Instanced items={shops} geometry={g.box} castShadow place={(o, s) => { o.position.set(s.x + 1, 0.3 + s.h, s.z); o.scale.set(1.6, 0.9, 1.2); }}>
        <meshStandardMaterial color="#9aa0a6" metalness={0.4} roughness={0.5} />
      </Instanced>
      {towers.map((t, i) => (
        <group key={i} position={[t.x, 0.3, t.z]}>
          <mesh position={[0, t.h / 2, 0]} castShadow receiveShadow>
            <boxGeometry args={[t.w, t.h, t.d]} />
            <meshStandardMaterial map={towerMaterials[i].map} emissiveMap={towerMaterials[i].emissive} emissive="#ffffff" emissiveIntensity={night ? 1.2 : 0} metalness={0.55} roughness={0.18} />
          </mesh>
          <mesh position={[0, t.h + 1, 0]} castShadow>
            <boxGeometry args={[t.w * 0.6, 2, t.d * 0.6]} />
            <meshStandardMaterial color="#4a525b" roughness={0.6} />
          </mesh>
          <mesh position={[0, 1.6, 0]}>
            <boxGeometry args={[t.w + 0.4, 3.2, t.d + 0.4]} />
            <meshStandardMaterial color="#2f363d" emissive={palette.windowLit} emissiveIntensity={night ? 0.35 : 0} roughness={0.3} metalness={0.4} />
          </mesh>
          {night && (
            <mesh position={[0, t.h + 2.4, 0]}>
              <sphereGeometry args={[0.35, 8, 6]} />
              <meshBasicMaterial color="#ff2a1a" toneMapped={false} />
            </mesh>
          )}
        </group>
      ))}
      {parks.map((p) => (
        <group key={`${p.i}-${p.j}`} position={[p.x, 0.31, p.z]}>
          <mesh rotation-x={-Math.PI / 2} position={[0, 0.01, 0]}>
            <ringGeometry args={[6.6, 8.2, 40]} />
            <meshStandardMaterial color="#c8bfae" roughness={0.95} />
          </mesh>
          <mesh rotation-x={-Math.PI / 2} position={[0, 0.02, 0]}>
            <circleGeometry args={[6.6, 40]} />
            <meshStandardMaterial color="#2f6f86" roughness={0.08} metalness={0.25} />
          </mesh>
          <mesh position={[0, 0.6, 0]} castShadow>
            <cylinderGeometry args={[1.2, 1.5, 1.2, 16]} />
            <meshStandardMaterial color="#d7d2c6" roughness={0.6} />
          </mesh>
          <mesh rotation-x={-Math.PI / 2} position={[0, 0.005, 0]}>
            <planeGeometry args={[layout.blockW - 4, 1.8]} />
            <meshStandardMaterial color="#c8bfae" roughness={0.95} />
          </mesh>
          <mesh rotation-x={-Math.PI / 2} position={[0, 0.005, 0]}>
            <planeGeometry args={[1.8, layout.blockD - 4]} />
            <meshStandardMaterial color="#c8bfae" roughness={0.95} />
          </mesh>
        </group>
      ))}
      <Instanced items={parkTrees} geometry={g.trunk} castShadow place={(o, t) => { o.position.set(t.x, 0.3, t.z); o.scale.set(t.s, 2.6 * t.s, t.s); }}>
        <meshStandardMaterial color="#5a4030" roughness={1} />
      </Instanced>
      <Instanced items={parkTrees} geometry={g.foliage} castShadow place={(o, t) => { o.position.set(t.x, 0.3 + 3.6 * t.s, t.z); o.scale.set(2 * t.s, 1.8 * t.s, 2 * t.s); }} color={(_, i) => ["#3e6b2c", "#4f7d33", "#5c8a3a"][i % 3]}>
        <meshStandardMaterial roughness={0.95} flatShading />
      </Instanced>
    </group>
  );
}

/* ---------- surroundings: mountains, sea, harbour, railway ---------- */

function Surroundings({ layout, palette, night }: { layout: TownLayout; palette: ThemePalette; night: boolean }) {
  const g = useGeometries();
  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const mountains = useMemo(
    () =>
      Array.from({ length: 30 }, (_, k) => ({
        x: minX - 700 + (k / 29) * (maxX - minX + 1300) + (hash(k, 50) - 0.5) * 120,
        z: minZ - 320 - hash(k, 51) * 650,
        r: 140 + hash(k, 52) * 230,
        h: 120 + hash(k, 53) * 300,
      })),
    [minX, maxX, minZ],
  );
  const forest = useMemo(
    () =>
      Array.from({ length: 1400 }, (_, k) => ({
        x: minX - 300 + hash(k, 60) * (maxX - minX + 500),
        z: minZ - 30 - hash(k, 61) * 300,
        s: 1.4 + hash(k, 62) * 1.6,
      })),
    [minX, maxX, minZ],
  );
  const railZ = maxZ + 30;
  const railStart = minX - 400;
  const railEnd = maxX + 6;
  const sleepers = useMemo(() => {
    const out: number[] = [];
    for (let x = railStart; x < railEnd; x += 1.4) out.push(x);
    return out;
  }, [railStart, railEnd]);
  const shoreX = maxX + 14;
  const seaX = maxX + 70;
  const pierZ = (minZ + maxZ) / 2;
  const mountainColor = palette.name.includes("賽博") ? "#2a2540" : palette.name.includes("蒸氣") ? "#5c5245" : "#5f6f5a";

  return (
    <group>
      <Instanced items={mountains} geometry={g.mountain} receiveShadow place={(o, m) => { o.position.set(m.x, -1, m.z); o.scale.set(m.r, m.h, m.r * 0.9); o.rotation.y = m.x; }} color={(_, i) => (i % 3 === 0 ? "#6c7466" : mountainColor)}>
        <meshStandardMaterial roughness={1} flatShading />
      </Instanced>
      <Instanced items={mountains} geometry={g.mountain} place={(o, m) => { const k = 0.3; o.position.set(m.x, -1 + m.h * (1 - k), m.z); o.scale.set(m.r * k * 1.02, m.h * k + 0.5, m.r * 0.9 * k * 1.02); o.rotation.y = m.x; }}>
        <meshStandardMaterial color="#f3f5f7" roughness={0.7} flatShading />
      </Instanced>
      <Instanced items={forest} geometry={g.pine} castShadow place={(o, t) => { o.position.set(t.x, 0, t.z); o.scale.set(1.8 * t.s, 6 * t.s, 1.8 * t.s); }} color={(_, i) => ["#2f5a2c", "#3a6633", "#284f27"][i % 3]}>
        <meshStandardMaterial roughness={1} flatShading />
      </Instanced>

      <mesh rotation-x={-Math.PI / 2} position={[(shoreX + seaX) / 2 + 4, 0.02, pierZ]} receiveShadow>
        <planeGeometry args={[seaX - shoreX + 10, 6000]} />
        <meshStandardMaterial color="#d8c6a0" roughness={1} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[seaX + 2500, 0.05, pierZ]}>
        <planeGeometry args={[5000, 6000]} />
        <meshStandardMaterial color={night ? "#0b2233" : "#1e6b86"} roughness={0.12} metalness={0.35} />
      </mesh>
      <mesh position={[seaX + 60, 1.6, pierZ]} castShadow receiveShadow>
        <boxGeometry args={[130, 0.6, 7]} />
        <meshStandardMaterial color="#8a6e52" roughness={0.9} />
      </mesh>
      <mesh position={[seaX + 40, 1.6, pierZ + 60]} castShadow receiveShadow>
        <boxGeometry args={[90, 0.6, 6]} />
        <meshStandardMaterial color="#8a6e52" roughness={0.9} />
      </mesh>
      <group position={[seaX + 128, 0, pierZ]}>
        <mesh position={[0, 12, 0]} castShadow>
          <cylinderGeometry args={[1.6, 2.4, 24, 16]} />
          <meshStandardMaterial color="#f2f2ee" roughness={0.6} />
        </mesh>
        {[6, 14].map((y) => (
          <mesh key={y} position={[0, y, 0]}>
            <cylinderGeometry args={[2.05, 2.15, 2.4, 16]} />
            <meshStandardMaterial color="#b3261e" roughness={0.6} />
          </mesh>
        ))}
        <mesh position={[0, 25.5, 0]}>
          <cylinderGeometry args={[1.3, 1.3, 2.4, 12]} />
          <meshStandardMaterial color="#fff6d6" emissive="#ffe08a" emissiveIntensity={night ? 4 : 0.4} />
        </mesh>
      </group>
      <Boats seaX={seaX} pierZ={pierZ} />

      <mesh position={[(railStart + railEnd) / 2, 0.15, railZ]} receiveShadow>
        <boxGeometry args={[railEnd - railStart, 0.3, 5]} />
        <meshStandardMaterial color="#7c766d" roughness={1} />
      </mesh>
      <Instanced items={sleepers} geometry={g.centeredBox} receiveShadow place={(o, x) => { o.position.set(x, 0.38, railZ); o.scale.set(0.35, 0.16, 3.4); }}>
        <meshStandardMaterial color="#4b3a2c" roughness={1} />
      </Instanced>
      {[-0.75, 0.75].map((off) => (
        <mesh key={off} position={[(railStart + railEnd) / 2, 0.55, railZ + off]}>
          <boxGeometry args={[railEnd - railStart, 0.14, 0.12]} />
          <meshStandardMaterial color="#9aa1a8" metalness={0.8} roughness={0.3} />
        </mesh>
      ))}
      <group position={[0, 0, maxZ + 15]}>
        <mesh position={[0, 4.5, 0]} castShadow receiveShadow>
          <boxGeometry args={[70, 9, 12]} />
          <meshStandardMaterial color="#d9d3c7" roughness={0.7} />
        </mesh>
        <mesh position={[0, 9.4, 0]} castShadow>
          <boxGeometry args={[74, 0.8, 14]} />
          <meshStandardMaterial color="#4a4f57" roughness={0.6} />
        </mesh>
        <mesh position={[0, 3.2, -6.05]}>
          <boxGeometry args={[30, 4.5, 0.1]} />
          <meshStandardMaterial color="#6f8798" emissive={palette.windowLit} emissiveIntensity={night ? 0.9 : 0} roughness={0.2} metalness={0.4} />
        </mesh>
        <mesh position={[0, 0.6, 10.5]} receiveShadow>
          <boxGeometry args={[130, 1.2, 6]} />
          <meshStandardMaterial color="#b8b2a6" roughness={0.9} />
        </mesh>
        <mesh position={[0, 5.4, 10.5]} castShadow>
          <boxGeometry args={[110, 0.3, 6.6]} />
          <meshStandardMaterial color="#5b6168" roughness={0.6} />
        </mesh>
      </group>
      <Train railZ={railZ} start={railStart} end={railEnd} night={night} />
    </group>
  );
}

function Boats({ seaX, pierZ }: { seaX: number; pierZ: number }) {
  const sailing = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!sailing.current) return;
    const t = clock.elapsedTime * 0.02;
    sailing.current.position.set(seaX + 260 + Math.cos(t) * 160, 0, pierZ + Math.sin(t) * 320);
    sailing.current.rotation.y = -t + Math.PI;
  });
  const boat = (key: string, color: string) => (
    <group key={key}>
      <mesh position={[0, 0.9, 0]} castShadow>
        <boxGeometry args={[4, 1.8, 12]} />
        <meshStandardMaterial color={color} roughness={0.6} />
      </mesh>
      <mesh position={[0, 2.6, -1.5]} castShadow>
        <boxGeometry args={[3, 1.8, 4]} />
        <meshStandardMaterial color="#f4f4f0" roughness={0.6} />
      </mesh>
    </group>
  );
  return (
    <group>
      {[0, 1, 2].map((k) => (
        <group key={k} position={[seaX + 30 + k * 26, 0, pierZ + 9]}>
          {boat(`m${k}`, ["#1f4e79", "#b3261e", "#2e7d32"][k])}
        </group>
      ))}
      <group ref={sailing}>{boat("s", "#ffffff")}</group>
    </group>
  );
}

function Train({ railZ, start, end, night }: { railZ: number; start: number; end: number; night: boolean }) {
  const ref = useRef<THREE.Group>(null);
  const length = 6 * 19;
  useFrame((_, dt) => {
    const train = ref.current;
    if (!train) return;
    train.position.x += 24 * Math.min(dt, 0.1);
    if (train.position.x > end + length) train.position.x = start;
  });
  return (
    <group ref={ref} position={[start + 200, 0, railZ]}>
      {Array.from({ length: 6 }, (_, k) => (
        <group key={k} position={[-k * 19, 0, 0]}>
          <mesh position={[0, 2.6, 0]} castShadow>
            <boxGeometry args={[18, 3.6, 3.2]} />
            <meshStandardMaterial color="#e9ecef" metalness={0.3} roughness={0.4} />
          </mesh>
          <mesh position={[0, 3, 1.62]}>
            <boxGeometry args={[16, 1, 0.05]} />
            <meshStandardMaterial color="#26323d" emissive="#ffe4a8" emissiveIntensity={night ? 1.4 : 0} />
          </mesh>
          <mesh position={[0, 3, -1.62]}>
            <boxGeometry args={[16, 1, 0.05]} />
            <meshStandardMaterial color="#26323d" emissive="#ffe4a8" emissiveIntensity={night ? 1.4 : 0} />
          </mesh>
          <mesh position={[0, 1.7, 0]}>
            <boxGeometry args={[18.05, 0.45, 3.25]} />
            <meshStandardMaterial color="#1d6fb8" roughness={0.5} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/* ---------- traffic ---------- */

type Car = { axis: "x" | "z"; road: number; lane: number; dir: 1 | -1; pos: number; speed: number; color: string };

function Traffic({ layout, night }: { layout: TownLayout; night: boolean }) {
  const g = useGeometries();
  const body = useRef<THREE.InstancedMesh>(null);
  const cabin = useRef<THREE.InstancedMesh>(null);
  const wheels = useRef<THREE.InstancedMesh>(null);
  const heads = useRef<THREE.InstancedMesh>(null);
  const tails = useRef<THREE.InstancedMesh>(null);
  const { roadsX, roadsZ, bounds, mainRoadX, mainRoadZ } = layout;
  const cars = useMemo<Car[]>(() => {
    const out: Car[] = [];
    const colors = ["#d7dadd", "#1f2937", "#9b1c1c", "#1e3a8a", "#f3f4f6", "#6b7280", "#14532d", "#b45309"];
    for (let k = 0; k < 300; k++) {
      const axis = hash(k, 70) < 0.5 ? "x" : "z";
      const roads = axis === "z" ? roadsX : roadsZ;
      const center = axis === "z" ? mainRoadX : mainRoadZ;
      const pick =
        hash(k, 71) < 0.7
          ? Math.min(roads.length - 1, Math.max(0, center + Math.round((hash(k, 72) - 0.5) * 12)))
          : Math.floor(hash(k, 73) * roads.length);
      const dir = hash(k, 74) < 0.5 ? 1 : -1;
      const min = axis === "z" ? bounds.minZ : bounds.minX;
      const max = axis === "z" ? bounds.maxZ : bounds.maxX;
      out.push({
        axis,
        road: roads[pick],
        lane: dir * 2.4,
        dir,
        pos: min + hash(k, 75) * (max - min),
        speed: 9 + hash(k, 76) * 7,
        color: colors[k % colors.length],
      });
    }
    return out;
  }, [roadsX, roadsZ, bounds, mainRoadX, mainRoadZ]);

  useLayoutEffect(() => {
    const c = new THREE.Color();
    cars.forEach((car, i) => {
      body.current?.setColorAt(i, c.set(car.color));
    });
    if (body.current?.instanceColor) body.current.instanceColor.needsUpdate = true;
  }, [cars]);

  const o = useMemo(() => new THREE.Object3D(), []);
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const meshes = [body.current, cabin.current, wheels.current, heads.current, tails.current];
    if (meshes.some((m) => !m)) return;
    cars.forEach((car, i) => {
      const min = car.axis === "z" ? bounds.minZ : bounds.minX;
      const max = car.axis === "z" ? bounds.maxZ : bounds.maxX;
      car.pos += car.dir * car.speed * dt;
      if (car.pos > max) car.pos = min;
      if (car.pos < min) car.pos = max;
      const x = car.axis === "z" ? car.road - car.lane : car.pos;
      const z = car.axis === "z" ? car.pos : car.road + car.lane;
      const rot = car.axis === "z" ? (car.dir > 0 ? 0 : Math.PI) : car.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
      const part = (mesh: THREE.InstancedMesh, y: number, forward: number, sx: number, sy: number, sz: number) => {
        o.position.set(x, 0, z);
        o.rotation.set(0, rot, 0);
        o.translateZ(forward);
        o.position.y = y;
        o.scale.set(sx, sy, sz);
        o.updateMatrix();
        mesh.setMatrixAt(i, o.matrix);
      };
      part(body.current!, 0.42, 0, 1.95, 0.85, 4.4);
      part(cabin.current!, 1.27, -0.3, 1.75, 0.78, 2.3);
      part(wheels.current!, 0.05, 0, 2.02, 0.62, 3.5);
      part(heads.current!, 0.82, 2.21, 1.5, 0.22, 0.08);
      part(tails.current!, 0.86, -2.21, 1.6, 0.2, 0.08);
    });
    for (const m of meshes) m!.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      <instancedMesh ref={body} args={[g.box, undefined, cars.length]} castShadow frustumCulled={false}>
        <meshStandardMaterial metalness={0.55} roughness={0.32} />
      </instancedMesh>
      <instancedMesh ref={cabin} args={[g.box, undefined, cars.length]} castShadow frustumCulled={false}>
        <meshStandardMaterial color="#1c2731" metalness={0.6} roughness={0.15} />
      </instancedMesh>
      <instancedMesh ref={wheels} args={[g.box, undefined, cars.length]} frustumCulled={false}>
        <meshStandardMaterial color="#111214" roughness={0.9} />
      </instancedMesh>
      <instancedMesh ref={heads} args={[g.box, undefined, cars.length]} frustumCulled={false}>
        <meshStandardMaterial color="#f8f6ec" emissive="#fff3c4" emissiveIntensity={night ? 4 : 0.2} />
      </instancedMesh>
      <instancedMesh ref={tails} args={[g.box, undefined, cars.length]} frustumCulled={false}>
        <meshStandardMaterial color="#7a1010" emissive="#ff2a1a" emissiveIntensity={night ? 3 : 0.3} />
      </instancedMesh>
    </group>
  );
}

/* ---------- markers & camera ---------- */

function OpenedMarkers({ layout, opened, selected }: { layout: TownLayout; opened: OpenedHouse[]; selected: number | null }) {
  const g = useGeometries();
  const items = useMemo(
    () => opened.map((o) => ({ ...o, lot: layout.houses[o.house] })).filter((o) => o.lot),
    [opened, layout.houses],
  );
  const sel = selected === null ? null : layout.houses[selected];
  const ring = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (ring.current) ring.current.scale.setScalar(1 + Math.sin(clock.elapsedTime * 4) * 0.08);
  });
  return (
    <group>
      <Instanced
        items={items}
        geometry={g.octa}
        place={(o, it) => {
          o.position.set(it.lot.x, 0.3 + it.lot.h + it.lot.roofH + 1.8, it.lot.z);
          o.scale.set(0.7, 1.1, 0.7);
        }}
        color={(it) => (it.result === "ae" ? "#facc15" : it.result === "bomb" ? "#ef4444" : "#94a3b8")}
      >
        <meshBasicMaterial toneMapped={false} />
      </Instanced>
      {sel && (
        <mesh ref={ring} rotation-x={-Math.PI / 2} position={[sel.x, 0.36, sel.z]}>
          <ringGeometry args={[Math.max(sel.w, sel.d) * 0.75, Math.max(sel.w, sel.d) * 0.75 + 0.5, 40]} />
          <meshBasicMaterial color="#2dd4bf" toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

function CameraRig({ layout, view, focus, recenter }: { layout: TownLayout; view: CameraView; focus: CameraFocus; recenter: number }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as Controls | null;
  const anim = useRef<{ from: THREE.Vector3; fromT: THREE.Vector3; to: THREE.Vector3; toT: THREE.Vector3; t: number } | null>(null);

  const start = (to: THREE.Vector3, toT: THREE.Vector3) => {
    if (!controls) return;
    anim.current = { from: camera.position.clone(), fromT: controls.target.clone(), to, toT, t: 0 };
  };

  useLayoutEffect(() => {
    if (!controls) return;
    const t = controls.target.clone();
    if (view === "street") start(new THREE.Vector3(t.x, 4.5, t.z + 26), new THREE.Vector3(t.x, EYE + 1.5, t.z));
    else start(new THREE.Vector3(t.x + 40, 150, t.z + 170), new THREE.Vector3(t.x, EYE, t.z));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, controls]);

  useLayoutEffect(() => {
    if (!controls || !focus) return;
    start(new THREE.Vector3(focus.x + 6, 10, focus.z + focus.facing * 24), new THREE.Vector3(focus.x, 2.6, focus.z));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.key, controls]);

  useLayoutEffect(() => {
    if (!controls || recenter === 0) return;
    start(new THREE.Vector3(60, view === "street" ? 4.5 : 150, view === "street" ? 30 : 190), new THREE.Vector3(0, EYE, 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recenter, controls]);

  useFrame((_, dt) => {
    if (!controls) return;
    const a = anim.current;
    if (a) {
      a.t = Math.min(1, a.t + dt / 1.1);
      const e = 1 - Math.pow(1 - a.t, 3);
      camera.position.lerpVectors(a.from, a.to, e);
      controls.target.lerpVectors(a.fromT, a.toT, e);
      controls.update();
      if (a.t >= 1) anim.current = null;
    }
    const { minX, maxX, minZ, maxZ } = layout.bounds;
    const tg = controls.target;
    const cx = THREE.MathUtils.clamp(tg.x, minX - 150, maxX + 220);
    const cz = THREE.MathUtils.clamp(tg.z, minZ - 150, maxZ + 80);
    if (cx !== tg.x || cz !== tg.z) {
      camera.position.x += cx - tg.x;
      camera.position.z += cz - tg.z;
      tg.x = cx;
      tg.z = cz;
    }
    if (camera.position.y < 1.8) camera.position.y = 1.8;
  });
  return null;
}

function SunLight({ night, mobile }: { night: boolean; mobile: boolean }) {
  const light = useRef<THREE.DirectionalLight>(null);
  const controls = useThree((s) => s.controls) as unknown as Controls | null;
  const scene = useThree((s) => s.scene);
  useLayoutEffect(() => {
    if (light.current) scene.add(light.current.target);
  }, [scene]);
  useFrame(() => {
    const l = light.current;
    if (!l || !controls) return;
    // Snap the shadow frustum to whole shadow-map texels so shadows don't shimmer while panning/zooming.
    const texel = 280 / (mobile ? 1024 : 2048);
    const tx = Math.round(controls.target.x / texel) * texel;
    const tz = Math.round(controls.target.z / texel) * texel;
    l.position.set(tx + (night ? -120 : 160), night ? 220 : 240, tz + (night ? 80 : 110));
    l.target.position.set(tx, 0, tz);
    l.target.updateMatrixWorld();
  });
  return (
    <directionalLight
      ref={light}
      castShadow
      intensity={night ? 0.5 : 2.6}
      color={night ? "#9db4ff" : "#fff1dc"}
      shadow-mapSize={[mobile ? 1024 : 2048, mobile ? 1024 : 2048]}
      shadow-camera-left={-140}
      shadow-camera-right={140}
      shadow-camera-top={140}
      shadow-camera-bottom={-140}
      shadow-camera-near={10}
      shadow-camera-far={700}
      shadow-bias={-0.0004}
      shadow-normalBias={0.5}
    />
  );
}

/* ---------- scene root ---------- */

export function TownScene({
  layout,
  theme,
  night,
  opened,
  selected,
  view,
  focus,
  recenter,
  onHouse,
}: {
  layout: TownLayout;
  theme: TownTheme;
  night: boolean;
  opened: OpenedHouse[];
  selected: number | null;
  view: CameraView;
  focus: CameraFocus;
  recenter: number;
  onHouse: (house: HouseLot) => void;
}) {
  const palette = TOWN_THEMES[theme];
  const mobile = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
  const fogColor = night ? "#070b16" : theme === "cyber" ? "#c9a9c9" : theme === "steam" ? "#cdb89c" : "#c9d9e4";
  return (
    <Canvas
      shadows
      dpr={[1, mobile ? 1.5 : 2]}
      camera={{ position: [70, 150, 190], fov: 50, near: 1, far: 6000 }}
      gl={{ antialias: true, powerPreference: "high-performance", logarithmicDepthBuffer: true }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = night ? 0.9 : 1.05;
      }}
    >
      <color attach="background" args={[night ? "#050915" : fogColor]} />
      <fog attach="fog" args={[fogColor, night ? 160 : 420, night ? 1500 : 3000]} />
      {night ? (
        <Stars radius={1800} depth={400} count={4000} factor={18} fade speed={0.4} />
      ) : (
        <Sky distance={4500} sunPosition={[160, 120, 110]} turbidity={palette.daySky.turbidity} rayleigh={palette.daySky.rayleigh} mieCoefficient={0.006} mieDirectionalG={0.85} />
      )}
      <ambientLight intensity={night ? 0.12 : 0.35} />
      <hemisphereLight args={[night ? "#2a3a66" : "#d6ebff", night ? "#0b0f1a" : palette.ground, night ? 0.4 : 0.75]} />
      <SunLight night={night} mobile={mobile} />
      {night && (
        <mesh position={[-900, 700, -1400]}>
          <sphereGeometry args={[45, 24, 16]} />
          <meshBasicMaterial color="#f4f1e0" fog={false} toneMapped={false} />
        </mesh>
      )}
      <Ground layout={layout} palette={palette} night={night} />
      <Houses layout={layout} palette={palette} night={night} onHouse={onHouse} />
      <Downtown layout={layout} palette={palette} night={night} />
      <StreetLights layout={layout} palette={palette} night={night} />
      <TrafficLights layout={layout} />
      <Traffic layout={layout} night={night} />
      <Surroundings layout={layout} palette={palette} night={night} />
      <OpenedMarkers layout={layout} opened={opened} selected={selected} />
      <MapControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minDistance={8}
        maxDistance={900}
        maxPolarAngle={1.48}
        screenSpacePanning={false}
        zoomSpeed={0.9}
      />
      <CameraRig layout={layout} view={view} focus={focus} recenter={recenter} />
    </Canvas>
  );
}

export { HOUSES_PER_BLOCK };
