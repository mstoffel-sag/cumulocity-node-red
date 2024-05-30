#!/bin/sh

c8y microservices list  --name node-red | c8y microservices createBinary --file node-red.zip --timeout 360
