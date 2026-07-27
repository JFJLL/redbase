/** Shared API types. Field names mirror the Node backend responses exactly. */

export interface SessionUser {
  id: string;
  phone?: string;
  nickname?: string;
  name?: string;
  credits?: number;
  isAdmin?: boolean;
  [key: string]: unknown;
}

export interface SessionResponse {
  user: SessionUser;
}

export interface OkResponse {
  ok: boolean;
}

export interface ApiErrorBody {
  error?: string;
  [key: string]: unknown;
}
