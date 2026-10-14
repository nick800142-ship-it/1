export type TownTheme = "modern" | "cyber" | "medieval" | "steam";

export type BlockKind = "res" | "shop" | "tower" | "park" | "empty";
export type Block = { i: number; j: number; x: number; z: number; kind: BlockKind };
export type HouseLot = {
  index: number;
  x: number;
  z: number;
  rot: number;
  w: number;
  d: number;
  h: number;
  roofH: number;
  wall: number;
  roof: number;
  chimney: boolean;
  litPattern: 0 | 1;
  tree: { x: number; z: number; s: number } | null;
};

export const ROAD = 10;
export const SIDEWALK = 1.6;
export const LOTS_X = 4;
export const LOTS_Z = 2;
export const HOUSES_PER_BLOCK = LOTS_X * LOTS_Z;

export function hash(a: number, b = 0) {
  const s = Math.sin(a * 12.9898 + b * 78.233 + 0.5) * 43758.5453;
  return s - Math.floor(s);
}

export type TownLayout = ReturnType<typeof buildTownLayout>;

export function buildTownLayout(houseCount: number, gap: number) {
  const spacing = Math.min(6, Math.max(2.2, gap)) - 3.2;
  const lotW = 8 + spacing * 1.5;
  const lotD = 11 + spacing * 1.5;
  const blockW = lotW * LOTS_X;
  const blockD = lotD * LOTS_Z;
  const pitchX = blockW + ROAD;
  const pitchZ = blockD + ROAD;

  const reserved = 12;
  const needed = Math.ceil(Math.max(1, houseCount) / HOUSES_PER_BLOCK) + reserved;
  const gz = Math.max(5, Math.ceil(Math.sqrt((needed * pitchX) / pitchZ)));
  const gx = Math.max(6, Math.ceil(needed / gz));

  const blockX = (i: number) => (i - (gx - 1) / 2) * pitchX;
  const blockZ = (j: number) => (j - (gz - 1) / 2) * pitchZ;
  const ci = Math.floor(gx / 2);
  const cj = Math.floor(gz / 2);

  const kindFor = (i: number, j: number): BlockKind => {
    if (i < ci - 2 || i > ci + 1 || j < cj - 1 || j > cj + 1) return "res";
    if (j === cj) return i === ci - 1 || i === ci ? "park" : "tower";
    return "shop";
  };

  const blocks: Block[] = [];
  for (let j = 0; j < gz; j++) {
    for (let i = 0; i < gx; i++) blocks.push({ i, j, x: blockX(i), z: blockZ(j), kind: kindFor(i, j) });
  }

  const residential = blocks
    .filter((b) => b.kind === "res")
    .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));

  const houses: HouseLot[] = [];
  for (const block of residential) {
    if (houses.length >= houseCount) {
      block.kind = "empty";
      continue;
    }
    for (let b = 0; b < LOTS_Z && houses.length < houseCount; b++) {
      for (let a = 0; a < LOTS_X && houses.length < houseCount; a++) {
        const index = houses.length;
        const r1 = hash(index, 1);
        const r2 = hash(index, 2);
        const r3 = hash(index, 3);
        const twoFloors = r1 < 0.32;
        const w = 4.4 + r2 * 1.4;
        const d = 4.4 + r3 * 1.1;
        const h = twoFloors ? 5.6 + r3 * 0.5 : 3.1 + r2 * 0.5;
        const lotCenterX = block.x + (a - (LOTS_X - 1) / 2) * lotW;
        const facingNorth = b === 0;
        const front = facingNorth ? block.z - blockD / 2 : block.z + blockD / 2;
        const inward = facingNorth ? 1 : -1;
        const z = front + inward * (SIDEWALK + 2.4 + d / 2);
        const backEdge = z + inward * (d / 2);
        const hasTree = hash(index, 7) < 0.7;
        houses.push({
          index,
          x: lotCenterX,
          z,
          rot: facingNorth ? Math.PI : 0,
          w,
          d,
          h,
          roofH: 1.5 + hash(index, 4) * 0.9,
          wall: Math.floor(hash(index, 5) * 6),
          roof: Math.floor(hash(index, 6) * 5),
          chimney: hash(index, 8) < 0.45,
          litPattern: hash(index, 9) < 0.5 ? 0 : 1,
          tree: hasTree
            ? {
                x: lotCenterX + (hash(index, 10) - 0.5) * (lotW - 3),
                z: (backEdge + block.z) / 2,
                s: 0.8 + hash(index, 11) * 0.6,
              }
            : null,
        });
      }
    }
  }

  const roadsX = Array.from({ length: gx + 1 }, (_, k) => blockX(k) - pitchX / 2);
  const roadsZ = Array.from({ length: gz + 1 }, (_, k) => blockZ(k) - pitchZ / 2);
  const minX = roadsX[0] - ROAD / 2;
  const maxX = roadsX[gx] + ROAD / 2;
  const minZ = roadsZ[0] - ROAD / 2;
  const maxZ = roadsZ[gz] + ROAD / 2;

  return {
    lotW,
    lotD,
    blockW,
    blockD,
    pitchX,
    pitchZ,
    gx,
    gz,
    ci,
    cj,
    blocks,
    houses,
    roadsX,
    roadsZ,
    mainRoadX: ci,
    mainRoadZ: cj,
    bounds: { minX, maxX, minZ, maxZ },
    downtown: { iMin: ci - 2, iMax: ci + 2, jMin: cj - 1, jMax: cj + 2 },
  };
}

export type ThemePalette = {
  name: string;
  walls: string[];
  roofs: string[];
  road: string;
  sidewalk: string;
  grass: string;
  ground: string;
  awnings: string[];
  windowLit: string;
  accent: string;
  daySky: { turbidity: number; rayleigh: number };
};

export const TOWN_THEMES: Record<TownTheme, ThemePalette> = {
  modern: {
    name: "現代清新小鎮",
    walls: ["#f2ede3", "#e6dccb", "#d9d6cf", "#f6f2ea", "#cfd8dc", "#e7d5b6"],
    roofs: ["#7a3b2e", "#4a4f57", "#8a4b33", "#3d434b", "#6b2f26"],
    road: "#3b3e43",
    sidewalk: "#b9b6ad",
    grass: "#5f8a45",
    ground: "#587d41",
    awnings: ["#c0392b", "#1f6f8b", "#2e7d32", "#e09f3e", "#6a4c93"],
    windowLit: "#ffd89a",
    accent: "#2dd4bf",
    daySky: { turbidity: 5, rayleigh: 1.4 },
  },
  cyber: {
    name: "賽博朋克霓虹城",
    walls: ["#2b2440", "#1f2a44", "#352a52", "#22303f", "#2d2236", "#1c2533"],
    roofs: ["#ff3fa4", "#00c2e0", "#8b5cf6", "#1b1830", "#ff7a1a"],
    road: "#17151f",
    sidewalk: "#3a3550",
    grass: "#2f3d3a",
    ground: "#232d2c",
    awnings: ["#ff2e97", "#00e5ff", "#a855f7", "#22d3ee", "#f97316"],
    windowLit: "#7cf3ff",
    accent: "#ff3fa4",
    daySky: { turbidity: 12, rayleigh: 3 },
  },
  medieval: {
    name: "中古世紀石造村落",
    walls: ["#b9ab93", "#a89b82", "#cbbd9f", "#9c8f78", "#d4c5a6", "#8f846f"],
    roofs: ["#6b4a2f", "#5a3d2a", "#7a5a3a", "#4b3a2c", "#8a6a42"],
    road: "#7d6d58",
    sidewalk: "#9a8b74",
    grass: "#6b8a4a",
    ground: "#647f45",
    awnings: ["#7f1d1d", "#365314", "#78350f", "#1e3a8a", "#57534e"],
    windowLit: "#ffb35c",
    accent: "#fbbf24",
    daySky: { turbidity: 8, rayleigh: 2 },
  },
  steam: {
    name: "蒸氣龐克工業風",
    walls: ["#9a5a3c", "#874c33", "#a86a48", "#7a4a35", "#b07a55", "#6e4130"],
    roofs: ["#3b3530", "#4a4038", "#2f2a26", "#5a4a3a", "#26221f"],
    road: "#3e3530",
    sidewalk: "#7a6a5a",
    grass: "#6a7a45",
    ground: "#5f6a3e",
    awnings: ["#b45309", "#7c2d12", "#a16207", "#3f3f46", "#92400e"],
    windowLit: "#ffa94d",
    accent: "#fb923c",
    daySky: { turbidity: 14, rayleigh: 2.6 },
  },
};
