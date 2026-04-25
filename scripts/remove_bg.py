import sys
from rembg import remove

with open(sys.argv[1], 'rb') as i:
    data = i.read()

output = remove(data)

with open(sys.argv[2], 'wb') as o:
    o.write(output)
