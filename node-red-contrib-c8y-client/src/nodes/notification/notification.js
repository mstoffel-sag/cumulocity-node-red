const { c8yClientLib, InventoryService } = require("@c8y/client");
const { getCredentials } = require("../c8y-utils/c8y-utils");
const Websocket = require("ws");
const uuid = require("uuid");

module.exports = function (RED) {
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
    node.refreshTokenInterval = 600000;

    getCredentials(RED, node);
    console.log();
    try {
      // Get properties
      node.deviceIds = RED.util.evaluateNodeProperty(
        node.config.deviceIds,
        node.config.deviceIdsType,
        node,
        undefined
      );
      node.deviceIds = node.deviceIds.split(",").filter((s) => s.trim());
      node.debug("DeviceIds:" + JSON.stringify(node.deviceIds));

      node.apis = RED.util.evaluateNodeProperty(
        node.config.apis,
        node.config.apisType,
        node,
        undefined
      );
      node.apis = node.apis.split(",").filter((s) => s.trim());
      if (node.apis.includes("*")) {
        node.apis = ["*"];
      }
      node.debug("APIs:" + JSON.stringify(node.apis));
      node.context = RED.util.evaluateNodeProperty(
        node.config.context,
        node.config.contextType,
        node,
        undefined
      );
      node.debug("Context:" + JSON.stringify(node.context));
    } catch (error) {
      node.error("Getting Properties: " + error);
      return;
    }

    node.createFilter =  function () {
      try {
        // Filter template
        let filter = {
          nonPersistent: node.nonPersistent,
          context: node.context,
          subscriptionFilter: {
            apis: node.apis,
          },
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
        
        if (node.subscription && node.deviceIds) {
          const filterResults =node.deviceIds.map((deviceId) =>
            node.postFilter(filter, deviceId)
          );
          Promise.all(filterResults).then((res) => {
            console.log("Promises all:", res);
            return Promise.resolve(res);
          });

        } else {
          node.error("Subscriber, Subscription or filter was undefined");
          return Promise.reject(
            "Subscriber, Subscription or filter was undefined"
          );
        }
      } catch (error) {
        node.error("createFilter: " + error);
        return Promise.reject(
          error
        );
      }
    };

    // Create filter in Cumulocity
    node.postFilter = function (filter, deviceId) {
      const localFilter = { ...filter };
      console.log(`postfilter filter: ${JSON.stringify(filter)} deviceid ${deviceId}` );
      if (!isNaN(parseInt(deviceId))) {
        localFilter.source = {};
        localFilter.source.id = deviceId;
      } else {
        node.error("deviceId not numeric skipping.")
        return  Promise.reject("deviceId not numeric skipping.");
      }
      localFilter.subscription = node.subscription;
      console.log(`postfilter filter localFilter: ${JSON.stringify(localFilter)}` );
      try {
        const fetchOptions = {
          method: "POST",
          body: JSON.stringify(localFilter),
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        };
        return node.client.core
          .fetch("notification2/subscriptions/", fetchOptions)
          .then(
            (res) => {
              if (res.status == 201) {
                return Promise.resolve("Filter created" + res.statusText);
                node.debug("Filter created");
              } else {
                return Promise.resolve(
                  "Creating filter. " +
                    res.status +
                    " " +
                    res.statusText +
                    " Filter: " +
                    JSON.stringify(filter)
                )
              }
            },
            (error) => {
              return Promise.resolve("postFilter" + error);
              node.error("postFilter" + error);
            }
          );
      } catch (error) {
        return Promise.resolve("postFilter" + error);
        node.error("postFilter: " + error);
      }
    };

    // will get a token and start the websocket connection. Handles reconnection
    node.subscribeWS =  (token) => {
      node.status({
        fill: "green",
        shape: "ring",
        text: "Connecting...",
      });

      function httpUrlToWebSockeUrl(url) {
        return url.replace(/(http)(s)?\:\/\//, "ws$2://");
      }

      const wsurl = httpUrlToWebSockeUrl(node.C8Y_BASEURL);
      node.debug("Connecting to websocket: " + wsurl);
      url = `${wsurl}/notification2/consumer/?token=${token}`;
      node.socket = new Websocket(url);
      node.socket.clientId = node.clientId;

      node.socket.onopen = function (e) {
        node.reconnectCount = 0;
        node.debug("[ws open] Connection established");
        node.status({
          fill: "green",
          shape: "dot",
          text: "Connected",
        });
        node
        node.heartBeatReference = setInterval(() => {
          node.socket.ping();
          node.debug("Ping websocket...");
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
            node.error(
              `[ws error] sending ack ${error} this can happen on closing connection`
            );
          }
        };
      };

      node.socket.onclose = function (event) {
        clearInterval(node.heartBeatReference);
        node.status({
          fill: "red",
          shape: "dot",
          text: `Disconnected: code=${event.code} ${event.reason}`,
        });
        node.debug(`[ws close] code=${event.code} reason=${event.reason}`);
        if (node.reconnectCount > 5 && node.reconnectTimeout < 600000) {
          node.reconnectTimeout = node.reconnectTimeout * node.reconnectCount;
          node.debug(
            "new reconnect timeout: " + node.reconnectTimeout / 1000 + " s"
          );
        }
        if (event.code !== 1000) {
          // setTimeout(function () {
          //   node.error(`Reconnecting..... Retries ${node.reconnectCount}`);
          //   node.reconnectCount = ++node.reconnectCount;
          //   node.subscribeWS(token);
          // }, node.reconnectTimeout);
        }
      };

      node.socket.onerror = function (error) {
        node.debug(
          `[ws error] Ready State: ${
            node.socket.readyState !== undefined ? node.socket.readyState : ""
          }`
        );

        node.status({
          fill: "red",
          shape: "dot",
          text: `Error: ${error.code}`,
        });
      };
    };

    node.getToken =  function () {
      node.debug(
        `Get Token for : Subscription: ${node.subscription}  Subscriber: ${node.subscriber}`
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
        async function getRes(fetchOptions){
          let c8yres = undefined;
          try {
            c8yres = await node.client.core.fetch(
              "notification2/token",
              fetchOptions
            );
          } catch (error) {
            node.error("Fetch Token: " + error);
            return Promise.reject(error);
          }
          if (c8yres.status == 200) {
            try {
              json = await c8yres.json();
              node.debug("Token received" + json.token);
              //node.token = json.token;
              return Promise.resolve(json.token);
            } catch (error) {
              node.error("get token json: " + error);
              return Promise.reject(error);
            }
          } else {
            node.error("Fetch Token: " + c8yres.status);
            return Promise.reject("Fetch Token: " + c8yres.status);
          }

        }
        return getRes(fetchOptions);
      } else {
        node.error("Subscriber, Subscription was undefined");
        return Promise.reject("Subscriber, Subscription was undefined");
      }
    };

    node.on("close", (done) => {
      node.debug("On Close");
      node.unsubscribeNotification();
      done();
    });

    node.unsubscribeNotification = function () {
      if (node.socket !== undefined) {
        node.debug("unsubscribeNotification");
        clearInterval(node.heartBeatReference);
        //clearInterval(node.refreshTokenIntervalReference);
        node.log("Closing ws connection");
        node.socket.close(1000, "Node Deactivated");
        node.socket = undefined;
      }
    };

    node.subscribeNotificationInner = async function () {
      let token = false;
      try {
        const filteresult = await node.createFilter();
        node.debug("FilterResult : " , filteresult);
  
        token = await node.getToken();
        
      } catch (error) {
        node.error("try filter token: " +error);
        return Promise.resolve(false);
      }
      node.debug("Token in subscribeNotificaiton: " + token);
      if (token) {
        node.debug("Found Token opening websocket." );
        node.subscribeWS(token);
        return Promise.resolve(true);
      } else {
        return Promise.resolve(false);
      }
    };

    node.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    node.subscribeNotification = async function () {
      success = false;
      while (!success) {
          success = await node.subscribeNotificationInner();

          if (success) {
            node.debug("success true");
          }else{
            node.debug("success false wait and retry");
            await node.sleep(5000);
          }
      }
      node.debug("while end");
    };
    // start node

    node.subscribeNotification();
  }

  // Register Node
  RED.nodes.registerType("notification", notificationNode);

  // Manage State
  RED.httpAdmin.get(
    "/notification/:id/:cmd",
    RED.auth.needsPermission("notification.write"),
    async function (req, res) {
      const cmd = req.params.cmd;
      const id = req.params.id;
      console.log(`/notification/${id}/${cmd}`);
      if (!id || !cmd) {
        console.log(`/notification id or cmd undefined`);
        res.sendStatus(404);
        return;
      }

      const node = RED.nodes.getNode(id);
      if (node) {
        node.debug(`httpAdmin /notificaiton/${id}/${cmd}`);
      } else {
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
      } else if (cmd == "getDevices" && node && node.client) {
        try {
          const filter = {
            fragmentType: "c8y_IsDevice",
            pageSize: 1000,
            withTotalPages: true,
          };
          const { data, paging } = await node.client.inventory.list(filter);
          // If there are more pages, fetch them as well
          let extract = (item) => {
            return { label: item.name, value: item.id };
          };
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
};
