import requests
import pprint

url = "https://doghouse.api.greyhoundcoin.net/mint/mint_txn"

payload={
    "address": "rQsYX4pCYrrMFtb4TQZEEf13YrLrNgyN3h",
    "pid":435
}

headers = {
    'Content-Type': 'application/json'
}

#post request
response = requests.request("POST", url, headers=headers, json=payload)

pprint.pprint(response.json())

