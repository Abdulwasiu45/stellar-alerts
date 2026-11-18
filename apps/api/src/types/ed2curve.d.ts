declare module "ed2curve" {
  function convertPublicKey(pk: Uint8Array): Uint8Array | null;
  function convertSecretKey(sk: Uint8Array): Uint8Array;

  const ed2curve: {
    convertPublicKey: typeof convertPublicKey;
    convertSecretKey: typeof convertSecretKey;
  };

  export default ed2curve;
}
