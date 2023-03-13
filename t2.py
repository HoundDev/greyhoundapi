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
    limit=200  # Increase the limit to get a more accurate estimate
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
    if gh == 0:
        print("GH is 0, skipping")
        continue
    if xrp == 0:
        print("XRP is 0, skipping")
        continue
    prices[counter] = {
        "xrp": xrp,
        "gh": gh,
        "price": xrp / gh
    }
    counter += 1

# Sort the prices by ascending price
sorted_prices = sorted(prices.values(), key=lambda x: x['price'])

sumGh = 0
sumXrp = 0
avgPrice = 0

amountXrp = Decimal(input("How much XRP do you want to spend? "))

# Traverse the order book and add up the GH until the total XRP spent is
# equal to or greater than the amount of XRP that the user wants to trade
for price in sorted_prices:
    if sumXrp >= amountXrp:
        break
    # sumGh += price["gh"]
    # sumXrp += price["xrp"]
    # avgPrice = sumXrp / sumGh
    if price["xrp"] + sumXrp > amountXrp:
        # If the price is too high, only add the amount of GH that is needed
        # to reach the amount of XRP that the user wants to trade
        sumGh += (amountXrp - sumXrp) / price["price"]
        sumXrp += (amountXrp - sumXrp)
        avgPrice = sumXrp / sumGh
    else:
        sumGh += price["gh"]
        sumXrp += price["xrp"]
        avgPrice = sumXrp / sumGh

print("Total GH: ", sumGh)
print("Total XRP: ", sumXrp)
