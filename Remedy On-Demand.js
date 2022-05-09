// remove '/' at the end of the url (if exists)
params.url = params.url.replace(/[\/]+$/, '');

var baseUrl = params.url;
if (params.port) {
    baseUrl = baseUrl + ':' + params.port;
}
var insecure = params.insecure;
var proxy = params.proxy;

// returns incId padded with '0's that is 15 length string. e.g. '82' -> '000000000000082'
var preperIncId = function (incId) {
    var res = '000000000000000' + incId;
    return res.substr(-15);
};

var createTableEntry = function (name, contents, context, headers) {
    return {
        // type
        Type: entryTypes.note,
         // contents
        ContentsFormat: formats.json,
        Contents: contents,
        // human-readable
        ReadableContentsFormat: formats.markdown,
        HumanReadable: tableToMarkdown(name, contents, headers),
        // context
        EntryContext: context
    };
};

// mutetor that removes all falsly fields
var filterEmptyFields = function(obj) {
    Object.keys(obj).forEach(function(key) {
        if (obj[key] === undefined || obj[key] === null) {
            delete obj[key];
        }
    });
};

var sendRequest = function(url, token, method, body) {

    var res = http(
        url,
        {
            Method: method || 'GET',
            Headers: {
                'Content-Type': ['application/json'],
                'Authorization': ['AR-JWT ' + token]
            },
            Body: body
        },
        insecure,
        proxy
    );

    if (res.StatusCode < 200 || res.StatusCode >= 300) {
        logout(token);
        throw 'Request Failed'
            + '\nurl: ' + url
            + '\nStatus code: ' + res.StatusCode
            + '\nBody: ' + JSON.stringify(res);
    }

    return res;
};

var login = function() {
    var url = baseUrl + '/api/jwt/login';

    var body = {
        username: params.credentials.identifier,
        password: params.credentials.password
    };

    var res = http(
        url,
        {
            Method: 'POST',
            Headers: {
                'Content-Type': ['application/x-www-form-urlencoded']
            },
            Body: encodeToURLQuery(body).replace(/^\?/, '')
        },
        insecure,
        proxy
    );

    if (!res || res.StatusCode < 200 || res.StatusCode >= 300) {
        throw 'Request Failed'
            + '\nurl: ' + url
            + '\nStatus code: ' + res.StatusCode
            + '.\nBody: ' + JSON.stringify(res, null, 2);
    }

    // retrun the body which is tokenKey
    return res.Body;
};

var logout = function(token) {
    var url = baseUrl + '/api/jwt/logout/';
    sendRequest(url, token, 'POST');
};

var convertIncidentToTicket = function(incident) {
    return {
        ID: incident['Incident Number'],
        Submitter: incident.Submitter,
        Status: incident.Status,
        Summary: incident.Description,
        Source: incident['Reported Source'],
        Impact: incident.Impact,
        Urgency: incident.Urgency,
        Type: incident.Service_Type,
        Assignee: incident['Assigned To'],
        Email: incident['Internet E-mail'],
        Priority: incident.Priority,
        ServiceType: incident.Service_Type,
        ModifiedDate: incident['Modified Date'],
        Incident: incident['Entry ID'],
        Notes: incident['Detailed Decription']
    };
};

//Maps the fields to be returned in XSOAR for Work Orders
var convertWorkOrderToTicket = function(incident) {
    return {
        ID: incident['Work Order ID'],
        Submitter: incident.Submitter,
        Status: incident.Status,
        Notes: incident['Detailed Description'],
        Summary: incident.Description,
        Assignee: incident['Request Assignee'],
        Email: incident['Customer Internet E-mail'],
        ModifiedDate: incident['Last Modified Date'],
        WorkOrder: incident['Request ID'],
        WOI: incident['WorkOrderID']
    };
};

//Maps the fields to be returned in XSOAR for Tasks
var convertTaskToTicket = function(incident) {
    return {
        ID: incident['TaskID'],
        Submitter: incident.Submitter,
        Status: incident.Status,
        Summary: incident.Summary,
        Notes: incident.Notes,
        Name: incident.TaskName,
        Impact: incident.Impact,
        RootRequestID: incident.RootRequestID,
        Type: incident.TaskType,
        Assignee: incident.Assignee,
        Priority: incident.Priority
    };
};

//Maps the fields to be returned in XSOAR for Policy Exception Requests
var convertPERToTicket = function(incident) {
    return {
        ID: incident['Policy Exception ID'],
        Title: incident['Policy Exception Name'],
        Type: incident['Request Type'],
        Path: incident['File Path'],
        Servers: incident['Server Name(s)_SVE'],
        Reason: incident['Why do you need this Policy Exception'],
        RootID: incident.WorkOrderID
    };
};

var createIncident = function(firstName, lastName, description, status, source, serviceType, impact, urgency, customFields) {
    var url = baseUrl + '/api/arsys/v1/entry/HPD:IncidentInterface_Create';
    var token = login();

    var body = {
       "values" : {
           "z1D_Action" : "CREATE",
     }
    };

    if (firstName) { body.values['First_Name'] = firstName; }
    if (lastName) { body.values['Last_Name'] = lastName; }
    if (description) { body.values['Description'] = description; }
    if (status) { body.values['Status'] = status; }
    if (source) { body.values['Reported Source'] = source; }
    if (serviceType) { body.values['Service_Type'] = serviceType; }
    if (impact) { body.values['Impact'] = impact; }
    if (urgency) { body.values['Urgency'] = urgency; }

    if (customFields) {
        var customFieldsArr = customFields.split(',');
        for (var i = 0; i < customFieldsArr.length; i++) {
            var equalIndex = customFieldsArr[i].indexOf('=');
            var key = customFieldsArr[i].substring(0, equalIndex);
            var value = customFieldsArr[i].substring(equalIndex + 1);
            body.values[key] = value;
        }
    }
    var res = sendRequest(url, token, "POST", JSON.stringify(body));
    // get created incident
    var incidentUrl = res && res.Headers && res.Headers.Location && res.Headers.Location[0];
    res = sendRequest(incidentUrl, token);
    logout(token);
    var incident = JSON.parse(res.Body).values;
    filterEmptyFields(incident);

    var context = {
        Ticket: convertIncidentToTicket(incident)
    };

    return createTableEntry("Incident created:",incident, context);
};

//Gets the associated PER ticket from a Work Order based on how our tickets are handled internally
var getAssociatedPERWO = function(id, title) {
    var url = baseUrl + '/api/arsys/v1/entry/WOI:Associations/?q=%27Request+ID02%27+%3D+%22' + id + '%22';
    var token = login();
    var res = sendRequest(url, token);
    logout(token);
    var incidentOne = JSON.parse(res.Body).entries[0].values;
    filterEmptyFields(incidentOne);

    var context = {
        'PER': {
            'RelatedID': incidentOne['Request ID01'],
        }
    };
    return {
        Type:entryTypes.note,
        Contents:context,
        ContentsType:formats.json,
        EntryContext:context
    };
};

var getIncident = function(id, title) {
    var url = baseUrl + '/api/arsys/v1/entry/HPD:IncidentInterface/' + id;
    var token = login();
    var res = sendRequest(url, token);
    logout(token);
    var incident = JSON.parse(res.Body).values;
    filterEmptyFields(incident);

    var context = {
        'Ticket(val.ID && val.ID == obj.ID)': convertIncidentToTicket(incident)
    };
    return createTableEntry(title || "Incident:",incident, context);
};

//Gets one Work Order based on the WorkOrderID field
var getWorkOrder = function(id, title) {
    var url = baseUrl + '/api/arsys/v1/entry/WOI:WorkOrderInterface/' + id;
    var token = login();
    var res = sendRequest(url, token);
    logout(token);
    var incident = JSON.parse(res.Body).values;
    filterEmptyFields(incident);

    var context = {
        'Ticket(val.ID && val.ID == obj.ID)': convertWorkOrderToTicket(incident)
    };
    return createTableEntry(title || "Incident:",incident, context);
};

//Gets one Task based on the TaskID field
var getTask = function(id, title) {
    var url = baseUrl + '/api/arsys/v1/entry/TMS:TaskInterface/' + id;
    var token = login();
    var res = sendRequest(url, token);
    logout(token);
    var incident = JSON.parse(res.Body).values;
    filterEmptyFields(incident);

    var context = {
        'Ticket(val.ID && val.ID == obj.ID)': convertTaskToTicket(incident)
    };
    return createTableEntry(title || "Incident:",incident, context);
};

//Gets a Policy Exception Request
var getPER = function(id, title) {
    var url = baseUrl + '/api/arsys/v1/entry/ADT:SEC-PolicyExceptionRequest/' + id;
    var token = login();
    var res = sendRequest(url, token);
    logout(token);
    var incident = JSON.parse(res.Body).values;
    filterEmptyFields(incident);

    var context = {
        'Policy Exception Request(val.ID && val.ID == obj.ID)': convertPERToTicket(incident)
    };
    return createTableEntry(title || "Incident:",incident, context);
};

var fetchIncidents = function(query, test_module=false) {
    var url = baseUrl + '/api/arsys/v1/entry/HPD:IncidentInterface/';
    if(query) {
        url += '?q=' + encodeURIComponent(query);
    }
    if (test_module) {
        url += '?limit=1'
    }
    var token = login();
    var res = sendRequest(url, token);
    logout(token);
    var body = JSON.parse(res.Body);

    var incidents = body.entries.map(function(b) { return b.values});
    incidents.forEach(filterEmptyFields);
    var context = {
        'Ticket(val.ID && val.ID == obj.ID)': incidents.map(convertIncidentToTicket)
    };
    return createTableEntry("Incidents:",incidents, context);
};

//Pulls Work Orders based on a query which can be searched on any of the API fields
//The API fields that can be queried is one or more
var fetchWorkOrders = function(query) {
    var url = baseUrl + '/api/arsys/v1/entry/WOI:WorkOrderInterface/?q=' + encodeURIComponent(query);
    var token = login();
    var res = sendRequest(url, token);
    logout(token);
    var body = JSON.parse(res.Body);

    var incidents = body.entries.map(function(b) { return b.values});
    incidents.forEach(filterEmptyFields);
    var context = {
        'Ticket(val.ID && val.ID == obj.ID)': incidents.map(convertWorkOrderToTicket)
    };
    return createTableEntry("Incidents:",incidents, context);
};

//Pulls Tasks based on a query which can be searched on any of the API fields
//The API fields that can be queried is one or more
var fetchTasks = function(query) {
    var url = baseUrl + '/api/arsys/v1/entry/TMS:TaskInterface/?q=' + encodeURIComponent(query);
    var token = login();
    var res = sendRequest(url, token);
    logout(token);
    var body = JSON.parse(res.Body);

    var incidents = body.entries.map(function(b) { return b.values});
    incidents.forEach(filterEmptyFields);
    var context = {
        'Ticket(val.ID && val.ID == obj.ID)': incidents.map(convertTaskToTicket)
    };
    return createTableEntry("Incidents:",incidents, context);
};

var updateIncident = function(incID, updateObject) {
    var url = baseUrl + '/api/arsys/v1/entry/HPD:IncidentInterface/' + incID + '|' + incID;
    var token = login();

    filterEmptyFields(updateObject);
    var body = {
       "values" : updateObject
    };

    sendRequest(url, token, "PUT", JSON.stringify(body));
    return getIncident(incID, 'Updated incident:');
};

//Update a Work Order based on the WorkOrderID field and returns the Work Order after updating
var updateWorkOrder = function(woID, updateObject) {
    var url = baseUrl + '/api/arsys/v1/entry/WOI:WorkOrderInterface/' + woID + '|' + woID;
    var token = login();

    filterEmptyFields(updateObject);
    var body = {
       "values" : updateObject
    };

    sendRequest(url, token, "PUT", JSON.stringify(body));
    return getWorkOrder(woID, 'Updated incident:');
};

//Update a Task based on the TaskID field and returns the Task after updating
var updateTask = function(tasID, updateObject) {
    var url = baseUrl + '/api/arsys/v1/entry/TMS:TaskInterface/' + tasID + '|' + tasID;
    var token = login();

    filterEmptyFields(updateObject);
    var body = {
       "values" : updateObject
    };

    sendRequest(url, token, "PUT", JSON.stringify(body));
    return getTask(tasID, 'Updated incident:');
};

//Adds Work Details to an Incident and returns the added Work Detail
var updateWorkDetailsINC = function(incID, ID, updateObject) {
    var url = baseUrl + '/api/arsys/v1/entry/HPD:WorkLog';
    var token = login();

    filterEmptyFields(updateObject);
    var body = {
       "values" : updateObject
    };

    sendRequest(url, token, "POST", JSON.stringify(body));
    return getLastWorkDetailINC(ID);
};

//Adds Work Details to an Work Order and returns the added Work Detail
var updateWorkDetailsWO = function(woID, ID, updateObject) {
    var url = baseUrl + '/api/arsys/v1/entry/WOI:WorkInfo';
    var token = login();

    filterEmptyFields(updateObject);
    var body = {
       "values" : updateObject
    };

    sendRequest(url, token, "POST", JSON.stringify(body));
    return getLastWorkDetailWO(ID);
};

//Pulls all Work Details associated with an Incident
var getWorkDetailsINC = function(incID) {
    var url = baseUrl + '/api/arsys/v1/entry/HPD:Help%20Desk/' + incID + '?fields=assoc(HPD:INC:Worklog)';

    var token = login();
    var res = sendRequest(url, token);
    var body = JSON.parse(res.Body);//.values;
    var worklogs = body["_links"]["assoc-HPD:INC:Worklog"];
    var worklogArr = [];

    worklogs.forEach(function(element){
        res = sendRequest(element["href"], token);
        body = JSON.parse(res.Body).values;
        filterEmptyFields(body);
        worklogArr.push(body);
    });

    logout(token);

    return worklogArr;
};

//Pulls all Work Details associated with a Work Order
var getWorkDetailsWO = function(woID) {
    var url = baseUrl + '/api/arsys/v1/entry/WOI:WorkInfo/?q=%27Work+Order+ID%27+%3D+%22' + woID + '%22';

    var token = login();
    var res = sendRequest(url, token);
    var body = JSON.parse(res.Body).entries;
    var worklogs = body;
    var worklogArr = [];

    worklogs.forEach(function(element){
        var link = element["_links"]["self"][0];
        res = sendRequest(link["href"], token);
        body = JSON.parse(res.Body).values;
        filterEmptyFields(body);
        worklogArr.push(body);
    });

    logout(token);

    return worklogArr;
};

//Gets the last Work Detail associated with an Incident
var getLastWorkDetailINC = function(incID) {
    var url = baseUrl + '/api/arsys/v1/entry/HPD:Help%20Desk/' + incID + '?fields=assoc(HPD:INC:Worklog)';

    var token = login();
    var res = sendRequest(url, token);
    var body = JSON.parse(res.Body);
    var worklog = body["_links"]["assoc-HPD:INC:Worklog"];

    res = sendRequest(worklog[worklog.length-1]["href"], token);
    body = JSON.parse(res.Body).values;
    filterEmptyFields(body);

    logout(token);
    return body;
};

//Gets the last Work Detail associated with an Work Order
var getLastWorkDetailWO = function(woID) {
        var url = baseUrl + '/api/arsys/v1/entry/WOI:WorkInfo/?q=%27Work+Order+ID%27+%3D+%22' + woID + '%22';

    var token = login();
    var res = sendRequest(url, token);
    var body = JSON.parse(res.Body);
    var worklogs = body.entries;

    var worklog = worklogs[worklogs.length-1];
    worklog = worklog["_links"]["self"][0]
    res = sendRequest(worklog["href"], token);
    body = JSON.parse(res.Body).values;
    filterEmptyFields(body);

    logout(token);
    return body;
};

var fetchIncidentsToDemisto = function() {
    var lastRun = getLastRun();
    nowDate = new Date();
    var now = nowDate.toISOString();
    if (!lastRun || !lastRun.value) {
        lastRun = {
            value: (new Date(nowDate.getTime() - 10*60*1000)).toISOString()
        };
    }
    logDebug("Last run value before starting to fetch: " + lastRun.value);
    var query =  "'Submit Date'>" + '"' + lastRun.value + '"';
    var url = baseUrl + '/api/arsys/v1/entry/HPD:IncidentInterface/' + '?q=' + encodeURIComponent(query);
    logDebug("This is the URL with the query for fetching the incidents: " + url);
    var token = login();
    var res = sendRequest(url, token);
    logout(token);
    var body = JSON.parse(res.Body);
    var incidents = []
    Object.keys(body.entries).forEach(function(key) {
        var incident = body.entries[key].values;
        var requestID = body.entries[key].values['Request ID'];
        incidents.push({
            'name': 'Remedy On-Demand incident ' + requestID,
            'labels': [
                {
                    'type': 'Ticket(val.ID && val.ID == obj.ID)',
                    'value': JSON.stringify(convertIncidentToTicket(incident)) // Ticket ID to be pushed to incident context
                }
            ],
            'rawJSON': JSON.stringify(incident)
        });
    });
    var now = new Date().toISOString();
    logDebug("Last run is set to: " + now);
    setLastRun({value: now});
    return JSON.stringify(incidents);
};

switch (command) {
    case 'test-module':
        fetchIncidents(query=null, test_module=true);
        return 'ok';
    case 'fetch-incidents':
        return fetchIncidentsToDemisto();
    case 'remedy-incident-create':
        return createIncident(
            args['first-name'],
            args['last-name'],
            args.description,
            args.status,
            args.source,
            args['service-type'],
            args.impact,
            args.urgency,
            args['custom-fields']
        );
    case 'remedy-get-incident':
        return getIncident(args.ID);
    case 'remedy-fetch-incidents':
        return fetchIncidents(args.query);
    case 'remedy-fetch-workorders':
        return fetchWorkOrders(args.query);
    case 'remedy-fetch-tasks':
        return fetchTasks(args.query);
    case 'remedy-incident-update':
        return updateIncident(
            args.ID,
            {
                Description: args.summary,
                Status: args.status,
                'Reported Source': args.source,
                'Service_Type': args['service-type'],
                Impact: args.impact,
                Urgency: args.urgency,
                Resolution: args.resolution,
                Assignee: args.assignee,
                'Assignee Login ID': args.assigneeID
            }
        );
    case 'remedy-workorder-update':
        return updateWorkOrder(
            args.ID,
            {
                Description: args.summary,
                Status: args.status,
                'CAB Manager ( Change Co-ord )': args.assigneeName,
                'CAB Manager Login': args.assigneeLogin,
                Priority: args.priority
            }
        );
    case 'remedy-get-workorder':
        return getWorkOrder(args.ID);
    case 'remedy-task-update':
        return updateTask(
            args.ID,
            {
                Notes: args.notes,
                Status: args.status,
                StatusReasonSelection: args.statusReason,
                Priority: args.priority,
                'Assignee Company': "ADT Security",
                'Assignee Organization': "Security",
                'Assignee Group': "Security Operations",
                Assignee: args.assignee
            }
        );
    case 'remedy-get-task':
        return getTask(args.ID);
    case 'remedy-inc-update-work-details':
        return updateWorkDetailsINC(
            args.ID, args.incID,
            {
                Submitter : args.username,
                'Assignee Groups' : "1000000002;1000000478;" + "'" + args.username + "';",
                Description : args.notes,
                'Detailed Description' : args.detailedNotes,
                'Work Log Submitter' : args.username,
                'Incident Number' : args.ID,
                'Work Log Type' : "General Information"
            }
        );
    case 'remedy-wo-update-work-details':
        return updateWorkDetailsWO(
            args.ID, args.woID,
            {
                Submitter : args.username,
                'Assignee Groups' : "1000000002;1000000478;" + "'" + args.username + "';",
                Description : args.notes, //Notes are only in the API and not in the UI
                'Detailed Description' : args.notes,
                'Work Log Submitter' : args.username,
                'WorkOrder_EntryID' : args.ID,
                'Work Order ID': args.woID,
                'Work Log Type' : "General Information"
            }
        );
    case 'remedy-inc-get-work-details':
        return getWorkDetailsINC(args.ID);
    case 'remedy-wo-get-work-details':
        return getWorkDetailsWO(args.ID);
    case 'remedy-get-policy-exception-request':
        return getPER(args.ID);
    case 'remedy-wo-get-associated-tickets':
        return getAssociatedPERWO(args.ID);
}
