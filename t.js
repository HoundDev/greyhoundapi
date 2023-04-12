const xrpl = require('xrpl');

async function checkHashMint(minting_hash) {
          const client = new xrpl.Client("wss://s1.ripple.com/");
          await client.connect();
          let submit = await client.request({ command: 'tx', transaction: "C597799AFC04CDCD07DAE0E2FBB977CE11A728242FF1437E6B9745FEED357A96" })
          await client.disconnect();
          return submit

}

// console.log(checkHashMint())
async function main() {
    try {
      await checkHashMint()
    } catch (error) {
      console.error(error.data.error);
    }
}

main()
