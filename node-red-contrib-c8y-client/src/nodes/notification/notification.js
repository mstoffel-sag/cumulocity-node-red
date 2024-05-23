const {c8yClientLib, InventoryService} = require('@c8y/client');
const {getCredentials} = require("../c8y-utils/c8y-utils");
const Websocket = require("ws");
const uuid = require("uuid");



module.exports = function(RED) {
    function notificationNode(config) {
      RED.nodes.createNode(this, config);
      var node = this;
      node.config = config;
      node.c8yconfig = RED.nodes.getNode(node.config.c8yconfig);
      node.subscriber = node.config.subscriber;
      node.subscription = node.config.subscription;
      node.nonPersistent = node.config.nonPersistent;
      node.typeFilter = node.config.typeFilter;
      node.fragmentsToCopy = node.config.fragmentsToCopy;
      node.socket = undefined;
      node.clientId = "nodeRed" + uuid.v4().replace(/-/g, "");
      node.reconnectTimeout = 10000;
      node.pingInterval = 180000;
      node.heartBeatReference = undefined;
      node.refreshTokenIntervalReference = undefined;
      node.reconnectCount = 0;
      node.expiresInMinutes = 10;
      node.refreshTokenInterval = (node.expiresInMinutes - 1) * 1000 * 60;
      node.token = undefined;


      getCredentials(RED, node);
      console.log()
      try {
        // Get properties
        node.deviceIds = RED.util.evaluateNodeProperty(
          node.config.deviceIds,
          node.config.deviceIdsType,
          node,
          undefined
          );
          node.deviceIds = node.deviceIds.split(",").filter((s) => s.trim());
          node.debug("DeviceIds:" + JSON.stringify(node.deviceIds) );

          node.apis = RED.util.evaluateNodeProperty(
          node.config.apis,
          node.config.apisType,
          node,
          undefined
          );
          node.apis = node.apis.split(",").filter(s => s.trim());
          if (node.apis.includes("*")) {
            node.apis = ["*"]
          }
          node.debug("APIs:" +JSON.stringify(node.apis ));

          node.context = RED.util.evaluateNodeProperty(
          node.config.context,
          node.config.contextType,
          node,
          undefined
        );
          node.debug("Context:" +JSON.stringify(node.context ));
      } catch (error) {
        node.error(error);
        return;
      }

      node.createFilter = async function (){
          // Filter template
          let filter = {
            nonPersistent: node.nonPersistent,
            context: node.context,
            subscriptionFilter: {
              apis: node.apis
            }
          };
          if (node.typeFilter) {
            filter.typeFilter = node.typeFilter;
          }
          if (node.fragmentsToCopy) {
            filter.fragmentsToCopy = node.fragmentsToCopy
              .split(",")
              .filter((s) => s.trim());
          }
          if (node.context == "tenant") {
            // No device source allowed in tenant context
            node.debug("Remove deviceIds since tenant context");
            node.deviceIds = [""];
          }
          node.debug("Filter template:", JSON.stringify(filter));
          if (node.subscription && node.deviceIds) {
            for (let index = 0; index < node.deviceIds.length; index++) {
                const localFilter = { ...filter };
                if (!isNaN( parseInt(node.deviceIds[index]))) {
                  localFilter.source = {};
                  localFilter.source.id = node.deviceIds[index];
                }else{
                  node.error("deviceId not numeric skipping.");
                }
                localFilter.subscription = node.subscription;
                node.log("Addin Mo Filter: " + JSON.stringify(localFilter));
                node.postFilter(localFilter);
              }
        } else {
          node.error("Subscriber, Subscription or filter was undefined");
        }
      }

      // Create filter in Cumulocity
      node.postFilter = async function (filter){
                const fetchOptions = {
                  method: "POST",
                  body: JSON.stringify(filter),
                  headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                  },
                };
              let c8yres = undefined;
              try {
                c8yres = await node.client.core.fetch(
                  "notification2/subscriptions/",
                  fetchOptions
                );
              } catch (error) {
                node.error(error);
                return;
              }
            if (c8yres.status == 201) {
                node.debug("Filter created");
            } else {
              node.error(
                "Creating filter. " +
                  c8yres.status +
                  " " +
                  c8yres.statusText +
                  " Filter: " +
                  JSON.stringify(filter)
              );
            }

      }

      // will get a token and start the websocket connection. Handles reconnection
      node.subscribeWS = async () => {
        await node.getToken();
        // refresh token
        node.refreshTokenIntervalReference = setInterval(async () => {
          node.debug("Refresh Token");
          await node.getToken();
        }, node.refreshTokenInterval);

        node.status({
          fill: "green",
          shape: "ring",
          text: "Connecting...",
        });

        url = `wss://${node.C8Y_BASEURL.replace(
          /(^\w+:|^)\/\//,
          ""
        )}/notification2/consumer/?token=${node.token}`;
        node.socket = new Websocket(url);
        node.socket.clientId = node.clientId;
        node.socket.onopen = function (e) {
          node.reconnectCount = 0;
          node.debug("[ws open] Connection established.");
          node.status({
            fill: "green",
            shape: "dot",
            text: "Connected",
          });
          node.heartBeatReference = setInterval(() => {
            node.socket.ping();
            node.debug("Ping!");
          }, node.pingInterval);
          node.socket.onmessage = function (event) {
            message = event.data.split("\n");
            const id = message[0];
            const source = message[1];
            const operation = message[2];
            const payload = message[4];
            node.debug(
              `New Notification id: ${id} source: ${source} operation: ${operation} \n payload: ${payload}`
            );
            const msg = {
              payload: {
                id: id,
                source: source,
                operation: operation,
                message: JSON.parse(payload),
              },
            };
            // Ack message
            try {
              node.socket.send(id);
              node.send(msg);
            } catch (error) {
              node.error(`[ws error] sending ack ${error} this can happen on closing connection`);
            }
          };
          node.socket.addEventListener("pong", (event) => {
            node.debug("Pong from server ", event.data);
          });
        };

        node.socket.onclose = function (event) {
          clearInterval(node.heartBeatReference);
          node.status({
            fill: "red",
            shape: "dot",
            text: `Disconnected: code=${event.code} ${event.reason}`,
          });
          node.debug(`[ws close] code=${event.code} reason=${event.reason}`);
          if (event.code !== 1000) {
            setTimeout(function () {
              node.debug(`Reconnecting.....${node.reconnectCount}`);
              node.reconnectCount = ++node.reconnectCount;
              node.subscribeWS();
            }, node.reconnectTimeout);
          }
        };

        node.socket.onerror = function (error) {
          node.error(
            `[ws error] ${JSON.stringify(error)} ${node.socket.readyState !== undefined ? node.socket.readyState : ""}`
          );

          node.status({
            fill: "red",
            shape: "dot",
            text: `Error: ${error.code}`,
          });
        };
      };

      node.getToken = async function () {
        node.debug(
          `Get Token: Subscription: ${node.subscription}  Subscriber: ${node.subscriber}`
        );
        if (node.subscriber !== undefined && node.subscription != undefined) {
          const fetchOptions = {
            method: "POST",
            body: JSON.stringify({
              subscription: node.subscription,
              subscriber: node.subscriber,
              expiresInMinutes: node.expiresInMinutes,
            }),
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
          };
          let c8yres = undefined;
          try {
            c8yres = await node.client.core.fetch(
              "notification2/token",
              fetchOptions
            );
          } catch (error) {
            node.error(error);
            return;
          }
          if (c8yres.status == 200) {
            try {
              json = await c8yres.json();
              node.debug("Token received");
              node.token = json.token;
              return;
            } catch (error) {
              node.error(error);
              return;
            }
          } else {
            node.error(c8yres.status);
            return;
          }
        } else {
          node.error("Subscriber, Subscription was undefined");
        }
      };

      node.on("close", (done) => {
        node.debug("On Close");
        setNodeState(node, false);
        done();
      });

      node.unsubscribeNotification = function () {
        if (node.socket !== undefined) {
          clearInterval(node.heartBeatReference);
          clearInterval(node.refreshTokenIntervalReference);
          node.log("Closing ws connection");
          node.socket.close(1000, "Node Deactivated");
//          node.socket = undefined;
        }
      };

      node.subscribeNotification = async function () {
        node.createFilter();
        node.subscribeWS();
      };

      // start node
      setNodeState(node,true);
    }

    // Manage node state
    setNodeState =  function (node,state) {
        if (state) {
            node.log(
              "Activating Subscription: " +
                node.subscription +
              " Subscriber: " + node.subscriber
            );

            if (node.subscriber && node.subscription ){
              node.subscribeNotification();
            }else{
              node.error("Missing config. Subscriber or Subscription not configured.")
            }
        } else {
            node.unsubscribeNotification();
        }
    }

    // Register Node
    RED.nodes.registerType("notification", notificationNode);

    // Manage State
    RED.httpAdmin.get(
      "/notification/:id/:cmd",
      RED.auth.needsPermission("notification.write"),
      async function (req, res) {
        const cmd= req.params.cmd;
        const id= req.params.id;
        console.log(`/notification/${id}/${cmd}`);
        if ( !id || !cmd) {
          console.log(`/notification id or cmd undefined`);
          res.sendStatus(404);
          return;
        }

        const node = RED.nodes.getNode(id);
        if (node) {
          node.debug(`httpAdmin /notificaiton/${id}/${cmd}` );
        }else{
          console.error("Node not found");
          res.sendStatus(404);
          return;
        }
        // Manage Node State
        if (cmd == "enable" || cmd == "disable") {
          if (node !== null && typeof node !== "undefined") {
            setNodeState(node, cmd === "enable");
            res.sendStatus(cmd === "enable" ? 200 : 201);
          } else {
            res.sendStatus(404);
            return;
          }

          //
        } else if (cmd == "getDevices" && node &&  node.c8yconfig ) {
            try {
              const filter = {
                fragmentType: "c8y_IsDevice",
                pageSize: 1000,
                withTotalPages: true,
              };
              const { data, paging } = await node.client.inventory.list(
                filter
              );
              // If there are more pages, fetch them as well
              let extract  =(item) => {
                return {label: item.name, value: item.id};
              }
              res.json(data.map(extract));
             // console.log("Devices:" ,devices);
            } catch (error) {
              node.error("Error fetching devices:", error);
              return;
            }
        } else {
          res.sendStatus(404);
        }
      }
    );
}
