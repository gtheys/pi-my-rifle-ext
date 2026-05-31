# Turtle (TTL) Syntax Primer

## Standard Prefixes

```turtle
@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
@prefix :     <https://example.org/ontology/> .
```

## Declaring a Class

```turtle
:Order a owl:Class ;
    rdfs:label "Order" ;
    rdfs:comment "A purchase order placed by a customer." .
```

## Data Property (column → literal value)

```turtle
:orderTotal a owl:DatatypeProperty ;
    rdfs:domain :Order ;
    rdfs:range  xsd:decimal ;
    rdfs:label  "order total" .
```

## Object Property (FK → relationship between classes)

```turtle
:placedBy a owl:ObjectProperty ;
    rdfs:domain :Order ;
    rdfs:range  :Customer ;
    rdfs:label  "placed by" ;
    owl:inverseOf :placed .

:placed a owl:ObjectProperty ;
    rdfs:domain :Customer ;
    rdfs:range  :Order ;
    rdfs:label  "placed" .
```

## Functional Property (UNIQUE column)

```turtle
:emailAddress a owl:DatatypeProperty, owl:FunctionalProperty ;
    rdfs:domain :Customer ;
    rdfs:range  xsd:string .
```

## Mandatory Property (NOT NULL column)

```turtle
:Order rdfs:subClassOf [
    a owl:Restriction ;
    owl:onProperty :placedBy ;
    owl:someValuesFrom :Customer
] .
```

## XSD Type Mapping

| SQL Type | XSD Type |
|----------|----------|
| VARCHAR, TEXT | xsd:string |
| INTEGER, INT | xsd:integer |
| BIGINT | xsd:long |
| DECIMAL, NUMERIC | xsd:decimal |
| FLOAT, DOUBLE | xsd:double |
| BOOLEAN | xsd:boolean |
| DATE | xsd:date |
| TIMESTAMP | xsd:dateTime |
| UUID | xsd:string (with pattern) |
| JSONB | xsd:string (note in comment) |
