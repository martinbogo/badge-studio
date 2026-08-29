// Copyright 2026 Martin Bogomolni
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * The host, chosen when the bundle is built.
 *
 * `@platform-impl` is a Vite alias resolving to `tauri.ts` or `web.ts`, so the
 * unused one is never bundled: the desktop build carries no font table and the
 * web build carries no Tauri client. Editor code imports from here and never
 * from either implementation.
 */

export { platform } from "@platform-impl";
export type * from "./types";
