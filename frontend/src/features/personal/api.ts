import { apiFetch } from "@/shared/api/client";

// Personal-IP creator material API. Mirrors src/server/api/personal-ip-routes.js:
// GET/POST /api/personal-materials, PUT/DELETE /api/personal-materials/:id.

export const MATERIAL_KINDS = [
  { value: "experience", label: "亲身经历" },
  { value: "case", label: "客户案例" },
  { value: "viewpoint", label: "观点表达" },
  { value: "quote", label: "常用金句" },
] as const;

export type MaterialKind = (typeof MATERIAL_KINDS)[number]["value"];

export interface CreatorMaterial {
  id: number;
  brandId: number;
  kind: string;
  title: string;
  content: string;
  tags: string[];
  sourceDate: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface MaterialPayload {
  brandId: number;
  kind: string;
  title: string;
  content: string;
  tags: string[];
  sourceDate: string;
}

export function materialKindLabel(kind: string): string {
  return MATERIAL_KINDS.find((item) => item.value === kind)?.label || kind;
}

export function fetchMaterials(brandId: number, signal?: AbortSignal): Promise<{ items: CreatorMaterial[] }> {
  return apiFetch<{ items: CreatorMaterial[] }>("/api/personal-materials", {
    query: { brandId },
    signal,
  });
}

export function createMaterial(payload: MaterialPayload): Promise<{ item: CreatorMaterial }> {
  return apiFetch<{ item: CreatorMaterial }>("/api/personal-materials", { method: "POST", body: payload });
}

export function updateMaterial(
  materialId: number,
  payload: MaterialPayload,
): Promise<{ item: CreatorMaterial }> {
  return apiFetch<{ item: CreatorMaterial }>(`/api/personal-materials/${materialId}`, {
    method: "PUT",
    body: payload,
  });
}

export function deleteMaterial(materialId: number): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/personal-materials/${materialId}`, { method: "DELETE" });
}
