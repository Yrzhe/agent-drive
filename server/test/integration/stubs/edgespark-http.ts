import { runtime } from "../edge-runtime";

export const auth = {
  get user() {
    return runtime.auth.user;
  },
  isAuthenticated(): boolean {
    return runtime.auth.authenticated && runtime.auth.user !== null;
  },
};
