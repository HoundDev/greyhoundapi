import requests
import json
import datetime
import pprint

def unix_to_datetime(unix_time):
    return datetime.datetime.fromtimestamp(unix_time).strftime('%Y-%m-%d %H:%M:%S')


def get_24h_data() -> None:
    twenty_four_volumer_getter = requests.get('https://api.onthedex.live/public/v1/ohlc?base=Greyhound.rJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ&quote=XRP&bars=24&interval=5')
    data = twenty_four_volumer_getter.json()
    pprint.pprint(data)
    ohlc = data['data']['ohlc']
    pprint.pprint(ohlc)
    counter = 1
    dict_to_be_written = {}
    for i in ohlc:
        str = f"{i['vq']}"
        dict_to_be_written[counter] = str
        counter += 1
    with open(r'gh-dash\volume_data.json','r+') as f:
        twenty_four = {"24h": dict_to_be_written}
        data = json.load(f)
        data = {}
        data.update(twenty_four)
        pprint.pprint(data)
        f.seek(0)
        json.dump(data, f, indent=4)
        f.truncate()

def write_7_day_data() -> None:
    r = requests.get('https://api.onthedex.live/public/v1/ohlc?base=Greyhound.rJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ&quote=XRP&bars=7&interval=D')
    data = r.json()
    ohlc = data['data']['ohlc']
    counter = 1
    dict_to_be_written = {}
    for i in ohlc:
        str = f"{i['vq']}"
        dict_to_be_written[counter] = str
        counter += 1
    with open(r'gh-dash\volume_data.json','r+') as f:
        seven_day = {"7d": dict_to_be_written}
        data = json.load(f)
        new_data = { **data, **seven_day }
        f.seek(0)
        json.dump(new_data, f, indent=4)
        f.truncate()

get_24h_data()
write_7_day_data()
