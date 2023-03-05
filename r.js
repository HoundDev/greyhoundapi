const xrpl = require("xrpl");
require("dotenv").config();
//send XRP from a wallet to another wallet

async function send_txn(dest_address, memo) {
    try {
        const wallet = xrpl.Wallet.fromSeed(process.env.SEED);
        const client = new xrpl.Client("wss://testnet.xrpl-labs.com/");
        await client.connect();

        const prepared = await client.autofill({
            "TransactionType": "Payment",
            "Account": wallet.address,
            "Amount": xrpl.xrpToDrops("0.0001"),
            "Destination": dest_address,
            "Memos": [
                {
                    "Memo": {
                        "MemoType": Buffer.from("test").toString("hex").toUpperCase(),
                        "MemoData": Buffer.from(memo).toString("hex").toUpperCase()
                    }
                }
            ]
          })

          const max_ledger = prepared.LastLedgerSequence
          console.log("Prepared transaction instructions:", prepared)
          console.log("Transaction cost:", xrpl.dropsToXrp(prepared.Fee), "XRP")
          console.log("Transaction expires after ledger:", max_ledger)

          const signed = wallet.sign(prepared)
          console.log("Identifying hash:", signed.hash)
          console.log("Signed blob:", signed.tx_blob)

          const tx = await client.submitAndWait(signed.tx_blob)

          console.log("Transaction result:", tx.result.meta.TransactionResult)
        //   console.log("Balance changes:", JSON.stringify(xrpl.getBalanceChanges(tx.result.meta), null, 2))
                
        await client.disconnect();
    } catch (error) {
        console.log(error);
    }
} 
let memo = "This is a test memo";

let dest_address = "rGgaiTCRe5Bbo54PbQnm2M75PdqLtgcwN1";

send_txn(dest_address, memo);