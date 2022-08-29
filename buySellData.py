import json
import pprint
import requests
from xrpl.clients import JsonRpcClient
from xrpl.models.requests import BookOffers
from xrpl.models.currencies import XRP, IssuedCurrency

client = JsonRpcClient('https://s2.ripple.com:51234/')

greyHound = IssuedCurrency(
    currency="47726579686F756E640000000000000000000000",
    issuer="rJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ"
)
SOLO_LINK = f'https://api.sologenic.org/api/v1/trades?symbol=47726579686F756E640000000000000000000000%2BrJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ%2FXRP'
req2 = BookOffers(taker_gets=XRP(), taker_pays=greyHound, limit=10,ledger_index="validated")
res2 = client.request(req2)
d = {"buyData":[],"sellData":[]}
for i in range(10):
    # print("==========================================================")
    # print(res2.result["offers"][i]["Account"])
    address = res2.result["offers"][i]["Account"]
    # print(float(res2.result["offers"][i]["TakerGets"])/1000000)
    TakerGets = float(res2.result["offers"][i]["TakerGets"])/1000000
    # print(res2.result["offers"][i]["TakerPays"]["value"])
    amount = res2.result["offers"][i]["TakerPays"]["value"]
    price = float(res2.result["offers"][i]['TakerGets'])/1000000 / float(res2.result["offers"][i]["TakerPays"]["value"])
    price = ("%.17f" % price)
    # print(price)
    # print("==========================================================")
    newData = {
        "address": address,
        "price": price,
        "TakerGetsXRP": TakerGets,
        "amountGH": amount
    }
    d["buyData"].append(newData)
with open('.dashboard.cache/buy_sell_data.json', 'w') as outfile:
    json.dump(d, outfile, indent=2)
    
r = requests.get(SOLO_LINK)
result = r.json()
for i in range(10):
    amount = result[i]["amount"]
    buyer = result[i]["buyer"]
    price = result[i]["price"]
    seller = result[i]["seller"]
    priceXrp = float(price) * float(amount)
    newData = {
        "buyer": buyer,
        "seller": seller,
        "price": price,
        "amount": amount,
        "priceXrp": priceXrp
    }
    d["sellData"].append(newData)
with open('.dashboard.cache/buy_sell_data.json', 'w') as outfile:
    json.dump(d, outfile, indent=2)
