import { createThirdwebClient } from "thirdweb";

/**
 * Thirdweb browser client.
 * Client IDs are public identifiers intended to be included in frontend code.
 * Never place a Thirdweb secret key in this file.
 */
export const THIRDWEB_CLIENT_ID = "863aff2b2a0b8890d76f525cfc25d47e";

export const thirdwebClient = createThirdwebClient({
  clientId: THIRDWEB_CLIENT_ID,
});
