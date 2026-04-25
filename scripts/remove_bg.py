import sys
from rembg import remove

input_path = sys.argv[1]
output_path = sys.argv[2]

with open(input_path, 'rb') as i:
    input_data = i.read()

output_data = remove(input_data)

with open(output_path, 'wb') as o:
    o.write(output_data)
