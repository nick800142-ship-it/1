import { createThirdwebClient } from "thirdweb";

/**
 * Thirdweb browser client.
 * Client IDs are public identifiers intended to be included in frontend code.
 * Never place a Thirdweb secret key in this file.
 */
export const THIRDWEB_CLIENT_ID =
  import.meta.env.VITE_THIRDWEB_CLIENT_ID ||
  "7f5421cb9980721c619ifeb0c1801db2";

export const thirdwebClient = createThirdwebClient({
  clientId: THIRDWEB_CLIENT_ID,
});
