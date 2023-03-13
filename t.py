import pprint
from xrpl.clients import JsonRpcClient
from xrpl.models.requests import BookOffers
from xrpl.models.currencies import IssuedCurrency, XRP
from xrpl.utils import drops_to_xrp
from decimal import Decimal

# Create a client to connect to the JSON RPC
client = JsonRpcClient("https://s1.ripple.com:51234/")

# Create a request to get the order book for Greyhound/XRP
request = BookOffers(
    taker_pays=XRP(),
    taker_gets=IssuedCurrency(
        currency="47726579686F756E640000000000000000000000",
        issuer="rJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ"
    ),
    ledger_index="validated",
    limit=None
)

# Send the request and get the response
response = client.request(request)

# Pretty print the response
# pprint.pprint(response.result)

prices = {}

counter = 0
for offer in response.result["offers"]:
    if 'taker_gets_funded' in offer:
        gh = Decimal(offer['taker_gets_funded']['value'])
    else:
        gh = Decimal(offer['TakerGets']['value'])
    if 'taker_pays_funded' in offer:
        xrp = drops_to_xrp(offer['taker_pays_funded'])
    else:
        xrp = drops_to_xrp(offer['TakerPays'])
    prices[counter] = {
        "xrp": xrp,
        "gh": gh,
        "price": xrp / gh
    }
    counter += 1

pprint.pprint(prices)

sumGh = 0
sumXrp = 0
avgPrice = 0

for price in prices:
    sumGh += prices[price]["gh"]
    sumXrp += prices[price]["xrp"]
    avgPrice += prices[price]["price"]

print("Total GH: ", sumGh)
print("Total XRP: ", sumXrp)

amountXrp = Decimal(input("Amount XRP: "))

# Calculate total GH based on the average price
totalGh = amountXrp / (sumXrp / len(prices)) * (sumGh / len(prices))

print("Total GH based on", amountXrp, "XRP:", totalGh)

