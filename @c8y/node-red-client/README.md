# node-red-contrib-c8y-client 

This package provides nodes to connect to Cumulocity IoT Platform. They can be used inside the Node-Red Cumulocity Micorservice or standalone.

## Authentication

All nodes can be configured with Cumulocity IoT credentials either via a configuration node or environment variables. In case of running inside of Cumulocity as a microservice the environment variables are automatically injected on runtime and enabeling the Use Env checkbox in the configuration dialog will use those values.

C8Y_TENANT=c8ytenantid
C8Y_USER=c8yusername
C8Y_PASSWORD=c8ypwd
C8Y_APPLICATION_KEY=optional

# Concept

## Dev

You can install the package after checkout like that:

    cd ~.node-red
    npm install <full path to git repo>/cumulocity-node-red/node-red-client

This will create a link in the node-red node-modules dir.
To test and restart node-red on file changes in development you can use nodemon in the node-red-client dir of the repo like that:

    nodemon --watch ./ -e js,html,json --exec "node-red"



